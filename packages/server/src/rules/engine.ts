import type { DynamicRuleDefinition } from "@ava/shared";
import type { Db } from "../db/db";
import { j, js, newId } from "../db/db";
import type { Clock } from "../core/clock";
import type { DecisionLog } from "../core/log";
import type { Counters, SettingsStore } from "../core/settings-store";
import type { ItemStore } from "../state/items";
import { BUILTIN_RULES } from "./builtin";
import type { Candidate } from "./candidates";
import { evaluateDynamicRule } from "./dynamic";
import type { RuleStore } from "./store";
import { encodeSnapshot, toWorldItem, type WorldState } from "./world";

export interface EvaluationResult {
  candidates: Candidate[];
  suppressed: { candidate: Candidate; reason: string }[];
  rulesEvaluated: number;
}

/** Firing outcomes that start a rule's cooldown for the same dedupe key. */
const COOLING_OUTCOMES = ["message_sent", "queued_for_brief", "prepared", "wake_requested", "validator_failed"];

export class RuleEngine {
  constructor(
    private db: Db,
    private clock: Clock,
    private items: ItemStore,
    private rules: RuleStore,
    private settings: SettingsStore,
    private counters: Counters,
    private log: DecisionLog,
    private activity: () => WorldState["activity"],
  ) {}

  /** Build the world snapshot rules evaluate against. */
  world(): WorldState {
    const now = this.clock.now();
    const s = this.settings.get();
    const horizonPast = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    const horizonFuture = new Date(now.getTime() + 15 * 86_400_000).toISOString();
    const open = this.items.list({ open: true }).filter((i) => i.type !== "event");
    const events = this.items.list({ types: ["event"], starts_between: [horizonPast, horizonFuture] });
    const recentClosed = this.db
      .all<{ id: string }>("SELECT id FROM items WHERE completed_at >= ? AND deleted_at IS NULL AND type != 'event'", [horizonPast])
      .map((r) => r.id);
    const closed = this.items.byIds(recentClosed);
    const blocks = this.db.all<{ id: string; item_id: string | null; title: string; start_at: string; end_at: string }>(
      "SELECT id, item_id, title, start_at, end_at FROM plan_blocks WHERE status = 'planned' AND end_at >= ? AND start_at <= ?",
      [now.toISOString(), horizonFuture],
    );
    return {
      at: now.toISOString(),
      tz: this.settings.tz(),
      location_id: this.settings.location().id,
      quiet: s.quiet_hours,
      items: [...open, ...events, ...closed].map(toWorldItem),
      plan_blocks: blocks,
      activity: this.activity(),
      messages_today: this.counters.get("messages.unprompted"),
    };
  }

  snapshot(w: WorldState, wakeId: string | null): void {
    this.db.run("INSERT INTO snapshots (id, wake_id, at, state) VALUES (?, ?, ?, ?)", [newId("snp"), wakeId, w.at, encodeSnapshot(w)]);
  }

  private inCooldown(c: Candidate, now: Date): string | null {
    const since = new Date(now.getTime() - c.cooldown_hours * 3_600_000).toISOString();
    const recent = this.db.get<{ at: string; outcome: string }>(
      `SELECT at, outcome FROM rule_firings WHERE dedupe_key = ? AND at >= ? AND outcome IN (${COOLING_OUTCOMES.map(() => "?").join(",")}) ORDER BY at DESC LIMIT 1`,
      [c.dedupe_key, since, ...COOLING_OUTCOMES],
    );
    if (recent) return `already ${recent.outcome.replace(/_/g, " ")} at ${recent.at} (cooldown ${c.cooldown_hours} h)`;
    for (const key of [`rule:${c.rule_id}`, `category:${c.category}`]) {
      const cd = this.db.get<{ until: string; reason: string }>("SELECT until, reason FROM cooldowns WHERE key = ? AND until > ?", [key, now.toISOString()]);
      if (cd) return `${key} cooling down until ${cd.until} (${cd.reason})`;
    }
    for (const id of c.item_ids) {
      const item = this.items.get(id);
      const snoozed = item?.data.snoozed_until as string | undefined;
      if (snoozed && new Date(snoozed) > now) return `${item!.title} is snoozed until ${snoozed}`;
    }
    return null;
  }

  /** Step 3 of the wake procedure: evaluate all active rules deterministically. */
  evaluate(w: WorldState, wakeId: string | null): EvaluationResult {
    const s = this.settings.get();
    const now = new Date(w.at);
    const raw: Candidate[] = [];
    let rulesEvaluated = 0;
    const activeBuiltins = new Set(this.rules.active("builtin").map((r) => r.id));
    for (const rule of BUILTIN_RULES) {
      if (!activeBuiltins.has(rule.id)) continue;
      rulesEvaluated++;
      try {
        raw.push(...rule.evaluate(w, s));
      } catch (e) {
        this.log.error("rule.error", `${rule.name} failed to evaluate: ${(e as Error).message}`, undefined, wakeId);
      }
    }
    for (const r of this.rules.active("dynamic")) {
      if (!r.approved_at) continue;
      rulesEvaluated++;
      const def = j<DynamicRuleDefinition | null>(r.definition, null);
      if (!def) continue;
      try {
        raw.push(...evaluateDynamicRule({ id: r.id, name: r.name }, def, w, s));
      } catch (e) {
        this.log.error("rule.error", `${r.name} failed to evaluate: ${(e as Error).message}`, undefined, wakeId);
      }
    }
    const candidates: Candidate[] = [];
    const suppressed: EvaluationResult["suppressed"] = [];
    const seen = new Set<string>();
    for (const c of raw) {
      if (seen.has(c.dedupe_key)) continue;
      seen.add(c.dedupe_key);
      const why = this.inCooldown(c, now);
      if (why) suppressed.push({ candidate: c, reason: why });
      else candidates.push(c);
    }
    candidates.sort((a, b) => b.priority - a.priority);
    this.log.info(
      "rules.evaluated",
      `Evaluated ${rulesEvaluated} rules: ${candidates.length} candidate${candidates.length === 1 ? "" : "s"}${suppressed.length ? `, ${suppressed.length} held back by cooldowns or snoozes` : ""}`,
      {
        candidates: candidates.map((c) => ({ rule: c.rule_name, items: c.item_ids, intent: c.intent, urgency: c.urgency })),
        suppressed: suppressed.map((x) => ({ rule: x.candidate.rule_name, items: x.candidate.item_ids, reason: x.reason })),
      },
      wakeId,
    );
    return { candidates, suppressed, rulesEvaluated };
  }

  recordFiring(c: Candidate, wakeId: string | null, outcome: string, messageId?: string | null, detail?: unknown): void {
    this.db.run("INSERT INTO rule_firings (id, rule_id, wake_id, at, item_ids, dedupe_key, outcome, message_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      newId("fir"),
      c.rule_id,
      wakeId,
      this.clock.now().toISOString(),
      js(c.item_ids),
      c.dedupe_key,
      outcome,
      messageId ?? null,
      detail === undefined ? null : js(detail),
    ]);
  }

  addCooldown(key: string, hours: number, reason: string): void {
    const now = this.clock.now();
    const until = new Date(now.getTime() + hours * 3_600_000).toISOString();
    this.db.run(
      "INSERT INTO cooldowns (key, until, reason, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET until = excluded.until, reason = excluded.reason, created_at = excluded.created_at",
      [key, until, reason, now.toISOString()],
    );
  }
}
