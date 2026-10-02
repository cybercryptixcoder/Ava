import {
  actionNeedsApproval,
  describeRule,
  evaluateCondition,
  inQuietHours,
  type DynamicRuleDefinition,
  type RuleExpiry,
  type RuleStats,
  type RuleStatus,
  type RuleView,
  type ShadowFiring,
  type ShadowResult,
} from "@ava/shared";
import type { Db } from "../db/db";
import { j, js, newId } from "../db/db";
import type { Clock } from "../core/clock";
import type { DecisionLog } from "../core/log";
import type { SettingsStore } from "../core/settings-store";
import { BUILTIN_RULES } from "./builtin";
import { CONSTITUTION, guardDynamicRule } from "./constitution";
import { evaluateDynamicRule } from "./dynamic";
import { decodeSnapshot, inClassBlock, makeResolver, type WorldState } from "./world";

interface RuleRow {
  id: string;
  tier: "builtin" | "dynamic";
  name: string;
  description: string;
  evidence: string | null;
  definition: string | null;
  params: string | null;
  action_kind: string;
  approval_tier: "auto" | "needs_approval";
  status: RuleStatus;
  enabled: number;
  expires_at: string | null;
  expiry: string | null;
  created_by: string;
  revision_of: string | null;
  proposed_revision: string | null;
  shadow: string | null;
  paused_reason: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
}

export class RuleStore {
  constructor(
    private db: Db,
    private clock: Clock,
    private settings: SettingsStore,
    private log: DecisionLog,
  ) {}

  private now() {
    return this.clock.now().toISOString();
  }

  /** Make sure every built-in rule has a row (for stats and the on/off switch). */
  seedBuiltins(): void {
    for (const r of BUILTIN_RULES) {
      const exists = this.db.get("SELECT id FROM rules WHERE id = ?", [r.id]);
      if (exists) continue;
      this.db.run(
        `INSERT INTO rules (id, tier, name, description, action_kind, approval_tier, status, enabled, created_by, created_at, updated_at, approved_at)
         VALUES (?, 'builtin', ?, ?, 'suggest', 'needs_approval', 'active', 1, 'system', ?, ?, ?)`,
        [r.id, r.name, r.description, this.now(), this.now(), this.now()],
      );
    }
  }

  row(id: string): RuleRow | undefined {
    return this.db.get<RuleRow>("SELECT * FROM rules WHERE id = ?", [id]);
  }

  definition(id: string): DynamicRuleDefinition | null {
    const r = this.row(id);
    return r?.definition ? j<DynamicRuleDefinition | null>(r.definition, null) : null;
  }

  /** Active, enabled rules of a tier. */
  active(tier?: "builtin" | "dynamic"): RuleRow[] {
    return this.db.all<RuleRow>(
      `SELECT * FROM rules WHERE status = 'active' AND enabled = 1 ${tier ? "AND tier = ?" : ""} ORDER BY created_at`,
      tier ? [tier] : [],
    );
  }

  category(ruleId: string): string {
    const b = BUILTIN_RULES.find((r) => r.id === ruleId);
    if (b) return b.category;
    return this.definition(ruleId)?.category ?? "dynamic";
  }

  isMessagingAllowed(ruleId: string): boolean {
    const r = this.row(ruleId);
    if (!r || r.status !== "active" || !r.enabled) return false;
    if (r.tier === "builtin") return true;
    // A dynamic rule that can message needs Shreyas's approval; approved_at is only set by the approval endpoint.
    return r.approval_tier === "needs_approval" ? !!r.approved_at : r.action_kind !== "suggest";
  }

  stats(ruleId: string): RuleStats {
    const now = this.clock.now().getTime();
    const fired = this.db.get<{ n: number; last: string | null }>("SELECT COUNT(*) AS n, MAX(at) AS last FROM rule_firings WHERE rule_id = ?", [ruleId]);
    const msgs = this.db.all<{ response: string | null; acted: number | null; sent_at: string | null; status: string }>(
      "SELECT response, acted, sent_at, status FROM messages WHERE rule_id = ? AND status IN ('sent','in_brief')",
      [ruleId],
    );
    let acted = 0,
      notNow = 0,
      already = 0,
      less = 0,
      ignored = 0,
      settled = 0;
    for (const m of msgs) {
      const age = m.sent_at ? (now - new Date(m.sent_at).getTime()) / 3_600_000 : 0;
      if (m.acted) acted++;
      if (m.response === "not_now") notNow++;
      if (m.response === "already_done") already++;
      if (m.response === "less_of_this") less++;
      if (!m.response && !m.acted && age >= 24) ignored++;
      if (m.response || m.acted || age >= 24) settled++;
    }
    return {
      fired: fired?.n ?? 0,
      messages: msgs.length,
      acted,
      not_now: notNow,
      already_done: already,
      less_of_this: less,
      ignored,
      precision: settled ? Math.round((acted / settled) * 100) / 100 : null,
      last_fired_at: fired?.last ?? null,
    };
  }

  view(id: string): RuleView | null {
    const r = this.row(id);
    if (!r) return null;
    const def = r.definition ? j<DynamicRuleDefinition | null>(r.definition, null) : null;
    const builtin = BUILTIN_RULES.find((b) => b.id === r.id);
    return {
      id: r.id,
      tier: r.tier,
      name: r.name,
      description: r.description,
      evidence: r.evidence,
      definition: def,
      readable: def ? describeRule(def) : r.description,
      action_kind: (r.action_kind as RuleView["action_kind"]) ?? "suggest",
      approval_tier: r.approval_tier,
      status: r.status,
      enabled: !!r.enabled,
      expires_at: r.expires_at,
      expiry: j<RuleExpiry | null>(r.expiry, null),
      created_by: r.created_by,
      created_at: r.created_at,
      stats: this.stats(r.id),
      shadow: j<ShadowResult | null>(r.shadow, null),
      revision_of: r.revision_of,
      proposed_revision: r.proposed_revision,
      params: builtin ? builtin.params(this.settings.get()) : undefined,
    };
  }

  list(): { constitution: typeof CONSTITUTION; builtin: RuleView[]; dynamic: RuleView[]; proposed: RuleView[] } {
    const rows = this.db.all<RuleRow>("SELECT id, tier, status FROM rules ORDER BY created_at");
    const views = rows.map((r) => this.view(r.id)!).filter(Boolean);
    return {
      constitution: CONSTITUTION,
      builtin: views.filter((v) => v.tier === "builtin"),
      dynamic: views.filter((v) => v.tier === "dynamic" && v.status !== "proposed" && v.status !== "rejected"),
      proposed: views.filter((v) => v.tier === "dynamic" && v.status === "proposed"),
    };
  }

  proposalsThisWeek(): number {
    const since = new Date(this.clock.now().getTime() - 7 * 86_400_000).toISOString();
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rules WHERE tier = 'dynamic' AND created_by = 'planner' AND created_at >= ? AND revision_of IS NULL", [since])?.n ?? 0;
  }

  activeDynamicCount(): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rules WHERE tier = 'dynamic' AND status = 'active' AND enabled = 1")?.n ?? 0;
  }

  /**
   * Record a rule proposed by the planner (or written by hand). Messaging
   * rules wait for approval; wake/prepare rules auto-approve within budget
   * when that setting is on. Either way they are listed and switchable.
   */
  propose(input: {
    name: string;
    evidence: string;
    definition: unknown;
    expiry?: RuleExpiry | null;
    expiry_days?: number;
    created_by: "planner" | "user";
    revision_of?: string | null;
  }): { ok: true; rule: RuleView } | { ok: false; errors: string[] } {
    const s = this.settings.get();
    const guard = guardDynamicRule(input.definition);
    if (!guard.ok || !guard.definition) {
      this.log.warn("rule.proposal_rejected", `Rejected proposed rule "${input.name}": ${guard.errors.join("; ")}`, { input });
      return { ok: false, errors: guard.errors };
    }
    if (input.created_by === "planner" && !input.revision_of && this.proposalsThisWeek() >= s.rules.max_new_per_week) {
      const msg = `Weekly proposal cap reached (${s.rules.max_new_per_week}); "${input.name}" was not proposed`;
      this.log.warn("rule.proposal_capped", msg);
      return { ok: false, errors: [msg] };
    }
    const def = guard.definition;
    const now = this.clock.now();
    const days = input.expiry_days ?? s.rules.default_expiry_days;
    const expiresAt = input.expiry?.at ? new Date(input.expiry.at).toISOString() : new Date(now.getTime() + days * 86_400_000).toISOString();
    const expiry: RuleExpiry = { at: expiresAt, ...(input.expiry?.when ? { when: input.expiry.when } : {}) };
    const needsApproval = actionNeedsApproval(def.action) || !s.approval.auto_approve_internal;
    const canAutoApprove = !needsApproval && this.activeDynamicCount() < s.rules.max_active_dynamic;
    const id = newId("rul");
    this.db.run(
      `INSERT INTO rules (id, tier, name, description, evidence, definition, action_kind, approval_tier, status, enabled, expires_at, expiry,
         created_by, revision_of, created_at, updated_at, approved_at)
       VALUES (?, 'dynamic', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        describeRule(def),
        input.evidence,
        js(def),
        def.action.kind,
        needsApproval ? "needs_approval" : "auto",
        canAutoApprove ? "active" : "proposed",
        expiresAt,
        js(expiry),
        input.created_by,
        input.revision_of ?? null,
        now.toISOString(),
        now.toISOString(),
        canAutoApprove ? now.toISOString() : null,
      ],
    );
    this.log.info(
      "rule.proposed",
      canAutoApprove ? `Auto-approved internal rule "${input.name}" (${def.action.kind})` : `Proposed rule "${input.name}" awaits approval`,
      { rule_id: id, definition: def, evidence: input.evidence },
    );
    return { ok: true, rule: this.view(id)! };
  }

  /** Only callable from an authenticated user action (the approve endpoint). */
  approve(id: string, via: "user"): RuleView {
    void via;
    const r = this.row(id);
    if (!r) throw new Error(`No rule ${id}`);
    if (r.tier !== "dynamic") throw new Error("Only dynamic rules need approval");
    if (this.activeDynamicCount() >= this.settings.get().rules.max_active_dynamic) {
      throw new Error(`You already have ${this.settings.get().rules.max_active_dynamic} active dynamic rules. Pause one before approving another.`);
    }
    const now = this.now();
    this.db.run("UPDATE rules SET status = 'active', enabled = 1, approved_at = ?, updated_at = ?, paused_reason = NULL WHERE id = ?", [now, now, id]);
    if (r.revision_of) {
      this.db.run("UPDATE rules SET status = 'expired', enabled = 0, updated_at = ?, paused_reason = 'replaced by revision' WHERE id = ?", [now, r.revision_of]);
    }
    this.log.info("rule.approved", `You approved "${r.name}"`, { rule_id: id });
    return this.view(id)!;
  }

  reject(id: string): RuleView {
    const now = this.now();
    this.db.run("UPDATE rules SET status = 'rejected', enabled = 0, updated_at = ? WHERE id = ? AND tier = 'dynamic'", [now, id]);
    this.log.info("rule.rejected", `You turned down rule ${this.row(id)?.name ?? id}`, { rule_id: id });
    return this.view(id)!;
  }

  setEnabled(id: string, enabled: boolean): RuleView {
    const r = this.row(id);
    if (!r) throw new Error(`No rule ${id}`);
    this.db.run("UPDATE rules SET enabled = ?, updated_at = ? WHERE id = ?", [enabled ? 1 : 0, this.now(), id]);
    this.log.info("rule.switched", `${r.name} switched ${enabled ? "on" : "off"}`, { rule_id: id });
    return this.view(id)!;
  }

  /** Hand edits to a dynamic rule's definition and expiry. */
  edit(id: string, patch: { name?: string; definition?: unknown; expires_at?: string; evidence?: string }): { ok: true; rule: RuleView } | { ok: false; errors: string[] } {
    const r = this.row(id);
    if (!r || r.tier !== "dynamic") return { ok: false, errors: ["Only dynamic rules can be edited"] };
    let def = j<DynamicRuleDefinition | null>(r.definition, null);
    if (patch.definition !== undefined) {
      const g = guardDynamicRule(patch.definition);
      if (!g.ok || !g.definition) return { ok: false, errors: g.errors };
      def = g.definition;
    }
    const now = this.now();
    const actionKind = def?.action.kind ?? r.action_kind;
    const needsApproval = def ? actionNeedsApproval(def.action) : r.approval_tier === "needs_approval";
    this.db.run(
      "UPDATE rules SET name = ?, definition = ?, description = ?, action_kind = ?, approval_tier = ?, expires_at = ?, evidence = ?, updated_at = ?, shadow = NULL WHERE id = ?",
      [
        patch.name ?? r.name,
        js(def),
        def ? describeRule(def) : r.description,
        actionKind,
        needsApproval ? "needs_approval" : "auto",
        patch.expires_at ? new Date(patch.expires_at).toISOString() : r.expires_at,
        patch.evidence ?? r.evidence,
        now,
        id,
      ],
    );
    this.log.info("rule.edited", `You edited "${patch.name ?? r.name}"`, { rule_id: id, definition: def });
    return { ok: true, rule: this.view(id)! };
  }

  /** Expire rules whose date has passed or whose expiry condition holds. */
  expireDue(world: WorldState): string[] {
    const expired: string[] = [];
    for (const r of this.db.all<RuleRow>("SELECT * FROM rules WHERE tier = 'dynamic' AND status IN ('active','paused','paused_low_precision','proposed')")) {
      const expiry = j<RuleExpiry | null>(r.expiry, null);
      const byDate = r.expires_at && new Date(r.expires_at) <= new Date(world.at);
      const byCond = expiry?.when ? evaluateCondition(expiry.when, makeResolver(world)) : false;
      if (byDate || byCond) {
        this.db.run("UPDATE rules SET status = 'expired', enabled = 0, updated_at = ?, paused_reason = ? WHERE id = ?", [
          world.at,
          byDate ? "expiry date reached" : "expiry condition met",
          r.id,
        ]);
        this.log.info("rule.expired", `"${r.name}" expired (${byDate ? "date reached" : "condition met"})`, { rule_id: r.id });
        expired.push(r.id);
      }
    }
    return expired;
  }

  /** Pause a rule whose precision fell below the threshold after enough messages. */
  checkSelfPause(ruleId: string): boolean {
    const r = this.row(ruleId);
    if (!r || r.status !== "active") return false;
    const s = this.settings.get().rules;
    const st = this.stats(ruleId);
    if (st.messages >= s.self_pause_min_messages && st.precision !== null && st.precision < s.self_pause_precision) {
      this.db.run("UPDATE rules SET status = 'paused_low_precision', updated_at = ?, paused_reason = ? WHERE id = ?", [
        this.now(),
        `precision ${st.precision} after ${st.messages} messages`,
        ruleId,
      ]);
      this.log.warn("rule.self_paused", `"${r.name}" paused itself: you acted on ${st.acted} of ${st.messages} messages (precision ${st.precision})`, { rule_id: ruleId, stats: st });
      return true;
    }
    return false;
  }

  setProposedRevision(ruleId: string, revisionId: string): void {
    this.db.run("UPDATE rules SET proposed_revision = ?, updated_at = ? WHERE id = ?", [revisionId, this.now(), ruleId]);
  }

  /**
   * Shadow mode: replay a rule over stored snapshots from the last few days
   * and record exactly what it would have done, including what the
   * constitution would have blocked.
   */
  shadow(ruleId: string, opts: { days?: number } = {}): ShadowResult {
    const r = this.row(ruleId);
    if (!r?.definition) throw new Error("Shadow mode needs a dynamic rule");
    const def = j<DynamicRuleDefinition>(r.definition, null as never);
    const s = this.settings.get();
    const to = this.clock.now();
    const from = new Date(to.getTime() - (opts.days ?? s.rules.shadow_days) * 86_400_000);
    const snaps = this.db.all<{ at: string; state: string }>("SELECT at, state FROM snapshots WHERE at >= ? AND at <= ? ORDER BY at", [from.toISOString(), to.toISOString()]);
    const firings: ShadowFiring[] = [];
    const lastFire = new Map<string, number>();
    const cooldownMs = (def.cooldown_hours ?? s.rules.default_cooldown_hours) * 3_600_000;
    for (const snap of snaps) {
      let w: WorldState;
      try {
        w = decodeSnapshot(snap.state);
      } catch {
        continue;
      }
      for (const c of evaluateDynamicRule({ id: r.id, name: r.name }, def, w, s)) {
        const at = new Date(w.at);
        const titles = c.item_ids.map((id) => w.items.find((i) => i.id === id)?.title ?? id);
        const last = lastFire.get(c.dedupe_key);
        let outcome: ShadowFiring["outcome"];
        let note = "";
        if (last !== undefined && at.getTime() - last < cooldownMs) {
          outcome = "blocked_cooldown";
          note = "Within the rule's cooldown";
        } else if (def.action.kind === "prepare") {
          outcome = "would_prepare";
          note = `Would prepare a ${def.action.executor.replace("_", " ")} silently`;
          lastFire.set(c.dedupe_key, at.getTime());
        } else if (def.action.kind === "wake") {
          outcome = "would_wake";
          note = def.action.reason;
          lastFire.set(c.dedupe_key, at.getTime());
        } else if (inQuietHours(at, w.tz, w.quiet.start, w.quiet.end)) {
          outcome = "would_queue_for_brief";
          note = "Quiet hours: would wait for the morning brief";
          lastFire.set(c.dedupe_key, at.getTime());
        } else if (inClassBlock(w, at)) {
          outcome = "blocked_class";
          note = "During a class or exam block";
        } else if (w.messages_today >= s.caps.unprompted_per_day) {
          outcome = "blocked_cap";
          note = "Daily message cap already reached";
        } else {
          outcome = "would_message";
          note = def.action.intent;
          lastFire.set(c.dedupe_key, at.getTime());
        }
        firings.push({ at: w.at, item_ids: c.item_ids, item_titles: titles, outcome, note });
      }
    }
    const result: ShadowResult = { from: from.toISOString(), to: to.toISOString(), snapshots_checked: snaps.length, firings, computed_at: to.toISOString() };
    this.db.run("UPDATE rules SET shadow = ?, updated_at = ? WHERE id = ?", [js(result), to.toISOString(), ruleId]);
    this.log.info("rule.shadow", `Shadow run for "${r.name}": ${firings.length} firings across ${snaps.length} snapshots`, { rule_id: ruleId });
    return result;
  }
}
