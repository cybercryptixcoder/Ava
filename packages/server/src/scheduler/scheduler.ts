import { DateTime } from "luxon";
import { atLocal, formatClock, spanPhrase, inQuietHours, isClosed, localDateKey, parseLocalTime, type Item, type WakeView } from "@ava/shared";
import type { Db } from "../db/db";
import { j, js, newId } from "../db/db";
import type { Clock } from "../core/clock";
import { SimClock } from "../core/clock";
import type { DecisionLog } from "../core/log";
import type { Counters, SettingsStore } from "../core/settings-store";
import type { EventBus } from "../core/events";
import type { ItemStore } from "../state/items";
import { freeBlocks, type WorldState } from "../rules/world";

export type WakeKind =
  | "heartbeat"
  | "brief"
  | "evening"
  | "weekly"
  | "consolidation"
  | "deadline"
  | "lookahead"
  | "event"
  | "planner"
  | "rule"
  | "executor"
  | "planning_new";

/** Kinds the system owns. Ava can never cancel these; anchors move only through settings. */
export const SYSTEM_ANCHORED: WakeKind[] = ["heartbeat", "brief", "evening", "weekly", "consolidation"];
/** Kinds Ava requests; these go through budget validation. */
export const AVA_REQUESTED: WakeKind[] = ["planner", "rule", "executor"];

export interface Wake {
  id: string;
  kind: WakeKind;
  due_at: string;
  anchor: { type: "local"; date: string; time: string } | null;
  status: "pending" | "running" | "done" | "failed" | "cancelled" | "skipped";
  owner: string;
  reason: string;
  item_ids: string[];
  payload: Record<string, unknown>;
  dedupe_key: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  outcome: string | null;
  error: string | null;
}

export interface WakeRequest {
  kind: WakeKind;
  at: Date;
  reason: string;
  owner: string;
  item_ids?: string[];
  payload?: Record<string, unknown>;
  dedupe_key?: string;
  anchor?: Wake["anchor"];
}

export type RequestResult = { ok: true; wake: Wake; merged?: boolean } | { ok: false; error: string };

function rowToWake(r: Record<string, unknown>): Wake {
  return {
    id: String(r.id),
    kind: r.kind as WakeKind,
    due_at: String(r.due_at),
    anchor: j(r.anchor, null),
    status: r.status as Wake["status"],
    owner: String(r.owner),
    reason: String(r.reason),
    item_ids: j(r.item_ids, []),
    payload: j(r.payload, {}),
    dedupe_key: (r.dedupe_key as string) ?? null,
    created_at: String(r.created_at),
    started_at: (r.started_at as string) ?? null,
    finished_at: (r.finished_at as string) ?? null,
    outcome: (r.outcome as string) ?? null,
    error: (r.error as string) ?? null,
  };
}

/**
 * The deterministic scheduler. It owns time: it creates system wakes,
 * validates every wake Ava asks for against budgets and quiet hours, and
 * runs wakes when they come due. Ava returns wake requests as data; she
 * can't create schedules directly.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  runner: (w: Wake) => Promise<string> = async () => "no runner";
  afterTick: () => Promise<void> = async () => {};

  constructor(
    private db: Db,
    private clock: Clock,
    private settings: SettingsStore,
    private counters: Counters,
    private items: ItemStore,
    private log: DecisionLog,
    private bus: EventBus,
  ) {}

  private now() {
    return this.clock.now();
  }

  get(id: string): Wake | null {
    const r = this.db.get("SELECT * FROM wakes WHERE id = ?", [id]);
    return r ? rowToWake(r) : null;
  }

  pending(opts: { from?: Date; to?: Date; kinds?: WakeKind[] } = {}): Wake[] {
    const where = ["status = 'pending'"];
    const p: string[] = [];
    if (opts.from) {
      where.push("due_at >= ?");
      p.push(opts.from.toISOString());
    }
    if (opts.to) {
      where.push("due_at <= ?");
      p.push(opts.to.toISOString());
    }
    if (opts.kinds?.length) {
      where.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`);
      p.push(...opts.kinds);
    }
    return this.db.all(`SELECT * FROM wakes WHERE ${where.join(" AND ")} ORDER BY due_at`, p).map(rowToWake);
  }

  recent(limit = 50): Wake[] {
    return this.db.all("SELECT * FROM wakes WHERE status != 'pending' ORDER BY COALESCE(finished_at, due_at) DESC LIMIT ?", [limit]).map(rowToWake);
  }

  between(from: Date, to: Date): Wake[] {
    return this.db
      .all("SELECT * FROM wakes WHERE due_at >= ? AND due_at < ? AND status != 'cancelled' ORDER BY due_at", [from.toISOString(), to.toISOString()])
      .map(rowToWake);
  }

  view(w: Wake): WakeView {
    return {
      id: w.id,
      kind: w.kind,
      due_at: w.due_at,
      status: w.status,
      owner: w.owner,
      reason: w.reason,
      item_ids: w.item_ids,
      movable: w.status === "pending" && !SYSTEM_ANCHORED.includes(w.kind),
      cancellable: w.status === "pending" && !SYSTEM_ANCHORED.includes(w.kind),
      finished_at: w.finished_at,
      outcome: w.outcome,
    };
  }

  private insert(req: WakeRequest): Wake {
    const id = newId("wak");
    this.db.run(
      "INSERT INTO wakes (id, kind, due_at, anchor, status, owner, reason, item_ids, payload, dedupe_key, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)",
      [id, req.kind, req.at.toISOString(), req.anchor ? js(req.anchor) : null, req.owner, req.reason, js(req.item_ids ?? []), js(req.payload ?? {}), req.dedupe_key ?? null, this.now().toISOString()],
    );
    this.counters.add(`wakes.created.${req.kind}`);
    this.counters.add("wakes.created");
    this.bus.emit({ type: "state.changed", what: ["wakes"] });
    this.reschedule();
    return this.get(id)!;
  }

  private pendingByDedupe(key: string): Wake | null {
    const r =
      this.db.get("SELECT * FROM wakes WHERE dedupe_key = ? AND status = 'pending'", [key]) ??
      this.db.get("SELECT * FROM wakes WHERE status = 'pending' AND kind = 'deadline' AND payload LIKE ?", [`%"${key}"%`]);
    return r ? rowToWake(r) : null;
  }

  /** System wakes skip budget checks but still dedupe. */
  system(req: WakeRequest): Wake {
    if (req.kind === "deadline" && req.dedupe_key && !this.pendingByDedupe(req.dedupe_key)) {
      // Several deadlines on the same morning share one wake.
      const same = this.db.get("SELECT * FROM wakes WHERE kind = 'deadline' AND status = 'pending' AND due_at = ?", [req.at.toISOString()]);
      if (same) {
        const w = rowToWake(same);
        const ids = Array.from(new Set([...w.item_ids, ...(req.item_ids ?? [])]));
        const keys = Array.from(new Set([...(w.payload.keys as string[] | undefined ?? [w.dedupe_key ?? ""]), req.dedupe_key])).filter(Boolean);
        this.db.run("UPDATE wakes SET item_ids = ?, reason = ?, payload = ? WHERE id = ?", [js(ids), w.reason.includes(req.reason) ? w.reason : `${w.reason}; ${req.reason}`, js({ ...w.payload, keys }), w.id]);
        return this.get(w.id)!;
      }
    }
    if (req.dedupe_key) {
      const existing = this.pendingByDedupe(req.dedupe_key);
      if (existing) {
        if (existing.due_at !== req.at.toISOString()) {
          this.db.run("UPDATE wakes SET due_at = ?, anchor = ?, reason = ? WHERE id = ?", [req.at.toISOString(), req.anchor ? js(req.anchor) : null, req.reason, existing.id]);
          this.reschedule();
        }
        return this.get(existing.id)!;
      }
    }
    return this.insert(req);
  }

  /**
   * Validate and create a wake Ava asked for. Rejections are logged with the
   * reason. A request near an existing one is merged instead of duplicated.
   */
  request(req: WakeRequest, wakeId?: string | null): RequestResult {
    const s = this.settings.get();
    const now = this.now();
    const tz = this.settings.tz();
    const fail = (error: string): RequestResult => {
      this.log.warn("schedule.rejected", `Wake request rejected (${req.kind}, ${formatClock(req.at, tz)}): ${error}`, { request: { ...req, at: req.at.toISOString() } }, wakeId);
      return { ok: false, error };
    };
    if (!AVA_REQUESTED.includes(req.kind)) return fail(`Ava can't request ${req.kind} wakes`);
    if (Number.isNaN(req.at.getTime())) return fail("Invalid time");
    if (req.at.getTime() <= now.getTime() + 60_000) return fail("Wake must be at least a minute in the future");
    if (req.at.getTime() > now.getTime() + s.wake_budget.horizon_days * 86_400_000) return fail(`Beyond the ${s.wake_budget.horizon_days}-day horizon`);
    if (req.kind !== "executor" && inQuietHours(req.at, tz, s.quiet_hours.start, s.quiet_hours.end)) return fail("Falls in quiet hours");
    const day = localDateKey(req.at, tz);
    const perKind = req.kind === "planner" ? s.wake_budget.planner_requests_per_day : req.kind === "rule" ? s.wake_budget.rule_wakes_per_day : s.wake_budget.executor_sessions_per_day;
    const usedKind = this.countForDay(req.kind, day);
    if (usedKind >= perKind) return fail(`Daily ${req.kind} wake budget reached (${usedKind}/${perKind})`);
    const usedTotal = AVA_REQUESTED.reduce((n, k) => n + this.countForDay(k, day), 0);
    if (usedTotal >= s.wake_budget.total_per_day) return fail(`Daily wake budget reached (${usedTotal}/${s.wake_budget.total_per_day})`);
    if (req.dedupe_key) {
      const dup = this.pendingByDedupe(req.dedupe_key);
      if (dup) return { ok: true, wake: dup, merged: true };
    }
    if (req.kind !== "executor") {
      const gap = s.wake_budget.min_gap_minutes * 60_000;
      const near = this.pending({ from: new Date(req.at.getTime() - gap), to: new Date(req.at.getTime() + gap), kinds: ["planner", "rule"] })[0];
      if (near) {
        const ids = Array.from(new Set([...near.item_ids, ...(req.item_ids ?? [])]));
        this.db.run("UPDATE wakes SET item_ids = ?, reason = ? WHERE id = ?", [js(ids), near.reason.includes(req.reason) ? near.reason : `${near.reason}; ${req.reason}`, near.id]);
        this.log.info("schedule.merged", `Merged wake request "${req.reason}" into the ${formatClock(near.due_at, tz)} wake`, { wake_id: near.id }, wakeId);
        return { ok: true, wake: this.get(near.id)!, merged: true };
      }
    }
    const wake = this.insert(req);
    this.log.info("schedule.created", `Scheduled ${req.kind} wake at ${formatClock(req.at, tz)}: ${req.reason}`, { wake_id: wake.id, owner: req.owner }, wakeId);
    return { ok: true, wake };
  }

  private countForDay(kind: WakeKind, localDay: string): number {
    const tz = this.settings.tz();
    // Count wakes of this kind that fall on that local day and weren't rejected.
    const start = DateTime.fromISO(localDay, { zone: tz }).startOf("day").toUTC().toISO()!;
    const end = DateTime.fromISO(localDay, { zone: tz }).endOf("day").toUTC().toISO()!;
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM wakes WHERE kind = ? AND due_at >= ? AND due_at <= ? AND status != 'cancelled'", [kind, start, end])?.n ?? 0;
  }

  /** Event wakes coalesce: many changes in a minute produce one wake. */
  event(reason: string, itemIds: string[] = []): Wake {
    const now = this.now();
    const soon = this.pending({ from: now, to: new Date(now.getTime() + 3 * 60_000), kinds: ["event"] })[0];
    if (soon) {
      const ids = Array.from(new Set([...soon.item_ids, ...itemIds]));
      const reasons = soon.reason.split("; ");
      if (!reasons.includes(reason) && reasons.length < 6) reasons.push(reason);
      this.db.run("UPDATE wakes SET item_ids = ?, reason = ? WHERE id = ?", [js(ids), reasons.join("; "), soon.id]);
      return this.get(soon.id)!;
    }
    return this.insert({ kind: "event", at: new Date(now.getTime() + 60_000), reason, owner: "system", item_ids: itemIds });
  }

  cancel(id: string, by: "user" | "system", reason: string): Wake {
    const w = this.get(id);
    if (!w) throw new Error(`No wake ${id}`);
    if (w.status !== "pending") return w;
    if (SYSTEM_ANCHORED.includes(w.kind) && by !== "system") throw new Error("This wake belongs to the system; change its time in Settings instead");
    this.db.run("UPDATE wakes SET status = 'cancelled', outcome = ?, finished_at = ? WHERE id = ?", [reason, this.now().toISOString(), id]);
    this.log.info("schedule.cancelled", `Cancelled ${w.kind} wake at ${formatClock(w.due_at, this.settings.tz())}: ${reason}`, { wake_id: id, by });
    this.bus.emit({ type: "state.changed", what: ["wakes"] });
    this.reschedule();
    return this.get(id)!;
  }

  /** Shreyas drags or snoozes one of Ava's planned wakes. */
  move(id: string, to: Date): Wake {
    const w = this.get(id);
    if (!w || w.status !== "pending") throw new Error("That wake isn't pending any more");
    if (SYSTEM_ANCHORED.includes(w.kind)) throw new Error("System wakes move with their settings");
    const s = this.settings.get();
    if (to.getTime() <= this.now().getTime()) throw new Error("Pick a time in the future");
    if (inQuietHours(to, this.settings.tz(), s.quiet_hours.start, s.quiet_hours.end)) throw new Error("That time is inside quiet hours");
    this.db.run("UPDATE wakes SET due_at = ?, anchor = NULL WHERE id = ?", [to.toISOString(), id]);
    this.log.info("schedule.moved", `You moved the ${w.kind} wake "${w.reason}" to ${formatClock(to, this.settings.tz())}`, { wake_id: id });
    this.bus.emit({ type: "state.changed", what: ["wakes"] });
    this.reschedule();
    return this.get(id)!;
  }

  /** Cancel pending wakes about an item (it was completed or removed). */
  cancelForItem(itemId: string, reason: string): number {
    let n = 0;
    for (const w of this.pending()) {
      if (!w.item_ids.includes(itemId) || SYSTEM_ANCHORED.includes(w.kind)) continue;
      const rest = w.item_ids.filter((x) => x !== itemId);
      if (rest.length && w.kind !== "deadline" && w.kind !== "executor") {
        this.db.run("UPDATE wakes SET item_ids = ? WHERE id = ?", [js(rest), w.id]);
      } else {
        this.cancel(w.id, "system", reason);
        n++;
      }
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // System wakes
  // -------------------------------------------------------------------------

  private nextLocal(time: string, after: Date, tz: string, weekday?: number): { at: Date; date: string } {
    const { hour, minute } = parseLocalTime(time);
    let d = DateTime.fromJSDate(after).setZone(tz).set({ hour, minute, second: 0, millisecond: 0 });
    for (let i = 0; i < 8; i++) {
      const ok = d.toJSDate() > after && (weekday === undefined || d.weekday === weekday);
      if (ok) break;
      d = d.plus({ days: 1 });
    }
    return { at: d.toJSDate(), date: d.toISODate()! };
  }

  /** Heartbeat slots: every N hours from the end of quiet hours, inside waking hours. */
  nextHeartbeat(after: Date): { at: Date; date: string; time: string } {
    const s = this.settings.get();
    const tz = this.settings.tz();
    const startMin = parseLocalTime(s.quiet_hours.end).hour * 60 + parseLocalTime(s.quiet_hours.end).minute;
    const step = s.heartbeat_every_hours * 60;
    let day = DateTime.fromJSDate(after).setZone(tz).startOf("day");
    for (let d = 0; d < 3; d++) {
      for (let m = startMin; m < startMin + 24 * 60; m += step) {
        const t = day.plus({ minutes: m });
        const at = t.toJSDate();
        if (at <= after) continue;
        if (inQuietHours(at, tz, s.quiet_hours.start, s.quiet_hours.end)) continue;
        return { at, date: t.toISODate()!, time: t.toFormat("HH:mm") };
      }
      day = day.plus({ days: 1 });
    }
    return { at: new Date(after.getTime() + step * 60_000), date: localDateKey(after, tz), time: "08:00" };
  }

  /** Keep exactly one pending heartbeat, brief, evening plan and weekly review. Idempotent. */
  ensureSystemWakes(): void {
    const s = this.settings.get();
    const tz = this.settings.tz();
    const now = this.now();
    if (!this.pending({ kinds: ["heartbeat"] }).length) {
      const hb = this.nextHeartbeat(now);
      this.system({ kind: "heartbeat", at: hb.at, reason: "Heartbeat: look ahead and poll sources", owner: "system", anchor: { type: "local", date: hb.date, time: hb.time }, dedupe_key: `heartbeat:${hb.at.toISOString()}` });
    }
    const pairs: [WakeKind, string, string, number | undefined][] = [
      ["brief", s.brief_time, "Morning brief", undefined],
      ["evening", s.evening_time, "Evening planning session", undefined],
      ["weekly", s.weekly_review.time, "Weekly review", ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].indexOf(s.weekly_review.weekday) + 1],
    ];
    for (const [kind, time, reason, weekday] of pairs) {
      if (this.pending({ kinds: [kind] }).length) continue;
      const n = this.nextLocal(time, now, tz, weekday);
      this.system({ kind, at: n.at, reason, owner: "system", anchor: { type: "local", date: n.date, time }, dedupe_key: `${kind}:${n.date}` });
    }
    if (s.memory.consolidation.enabled && !this.pending({ kinds: ["consolidation"] }).length) {
      const n = this.nextLocal(s.memory.consolidation.at_local, now, tz);
      this.system({ kind: "consolidation", at: n.at, reason: "Nightly memory consolidation", owner: "system", anchor: { type: "local", date: n.date, time: s.memory.consolidation.at_local }, dedupe_key: `consolidation:${n.date}` });
    }
  }

  /** Deadline wakes at 14, 3 and 1 days out (default), at the configured local time. */
  syncDeadlineWakes(item: Item): void {
    const s = this.settings.get();
    const tz = this.settings.tz();
    for (const w of this.pending({ kinds: ["deadline"] })) {
      if (!w.item_ids.includes(item.id)) continue;
      const rest = w.item_ids.filter((x) => x !== item.id);
      if (rest.length) {
        const keys = ((w.payload.keys as string[] | undefined) ?? []).filter((k) => !k.startsWith(`deadline:${item.id}:`));
        this.db.run("UPDATE wakes SET item_ids = ?, payload = ? WHERE id = ?", [js(rest), js({ ...w.payload, keys }), w.id]);
      } else this.db.run("UPDATE wakes SET status = 'cancelled', outcome = 'resynced', finished_at = ? WHERE id = ?", [this.now().toISOString(), w.id]);
    }
    if (!item.due_at || isClosed(item.type, item.status) || !["task", "commitment"].includes(item.type)) return;
    const due = new Date(item.due_at);
    const dueDate = DateTime.fromJSDate(due).setZone(tz);
    for (const offset of s.deadline_offsets_days) {
      const date = dueDate.minus({ days: offset }).toISODate()!;
      let at = atLocal(date, s.deadline_wake_time, tz);
      if (at >= due) at = new Date(due.getTime() - 2 * 3_600_000);
      if (inQuietHours(at, tz, s.quiet_hours.start, s.quiet_hours.end)) continue;
      if (at <= this.now()) continue;
      this.system({
        kind: "deadline",
        at,
        reason: `${item.title}: ${offset} day${offset === 1 ? "" : "s"} out`,
        owner: "system",
        item_ids: [item.id],
        anchor: { type: "local", date, time: s.deadline_wake_time },
        dedupe_key: `deadline:${item.id}:${offset}`,
        payload: { offset },
      });
    }
  }

  /**
   * Heartbeat lookahead: request precise wakes for the coming window so good
   * moments don't fall between heartbeats (class ends 1:15, wake at 1:20).
   */
  lookahead(w: WorldState, untilHours: number): Wake[] {
    const s = this.settings.get();
    const now = new Date(w.at);
    const until = new Date(now.getTime() + untilHours * 3_600_000);
    const created: Wake[] = [];
    for (const b of freeBlocks(w, now, untilHours + 2)) {
      if (b.minutes < s.rules.free_block_min_minutes) continue;
      const start = new Date(b.start);
      if (start <= now || start > until) continue;
      const at = b.after_event_id ? new Date(start.getTime() + 5 * 60_000) : new Date(start.getTime() - s.rules.free_block_lead_minutes * 60_000);
      if (at <= now) continue;
      const after = b.after_event_id ? w.items.find((i) => i.id === b.after_event_id) : null;
      created.push(
        this.system({
          kind: "lookahead",
          at,
          reason: after ? `After ${after.title}, ${spanPhrase(b.minutes)} free` : `Before ${spanPhrase(b.minutes)} free from ${formatClock(b.start, w.tz)}`,
          owner: "system",
          item_ids: after ? [after.id] : [],
          dedupe_key: `lookahead:${b.start.slice(0, 16)}`,
        }),
      );
    }
    return created;
  }

  /** Switching location recomputes every schedule in the new time zone. */
  recomputeForTimezone(prevTz: string): void {
    const tz = this.settings.tz();
    const now = this.now().toISOString();
    let n = 0;
    for (const w of this.pending({ kinds: ["heartbeat", "brief", "evening", "weekly", "lookahead"] })) {
      this.db.run("UPDATE wakes SET status = 'cancelled', outcome = 'time zone changed', finished_at = ? WHERE id = ?", [now, w.id]);
      n++;
    }
    this.ensureSystemWakes();
    for (const item of this.items.list({ open: true }).filter((i) => i.due_at)) this.syncDeadlineWakes(item);
    // Planner wakes anchored to a local time keep their local time.
    for (const w of this.pending({ kinds: ["planner", "rule"] })) {
      if (!w.anchor) continue;
      const at = atLocal(w.anchor.date, w.anchor.time, tz);
      this.db.run("UPDATE wakes SET due_at = ? WHERE id = ?", [at.toISOString(), w.id]);
      n++;
    }
    this.log.info("schedule.timezone", `Time zone changed from ${prevTz} to ${tz}; recomputed ${n} wakes`, { from: prevTz, to: tz });
    this.bus.emit({ type: "state.changed", what: ["wakes", "settings"] });
    this.reschedule();
  }

  // -------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------

  start(): void {
    this.reschedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private reschedule(): void {
    if (this.clock instanceof SimClock) return;
    if (this.timer) clearTimeout(this.timer);
    const next = this.pending()[0];
    const delay = next ? Math.max(0, Math.min(new Date(next.due_at).getTime() - this.now().getTime(), 30_000)) : 30_000;
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref?.();
  }

  /** Run every wake that is due, oldest first, one at a time. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let ran = 0;
    try {
      for (;;) {
        const due = this.db.get("SELECT * FROM wakes WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 1", [this.now().toISOString()]);
        if (!due) break;
        await this.runOne(rowToWake(due));
        ran++;
      }
      await this.afterTick();
    } finally {
      this.running = false;
      this.reschedule();
    }
    return ran;
  }

  private async runOne(w: Wake): Promise<void> {
    const startedAt = this.now().toISOString();
    this.db.run("UPDATE wakes SET status = 'running', started_at = ? WHERE id = ?", [startedAt, w.id]);
    try {
      const outcome = await this.runner(w);
      this.db.run("UPDATE wakes SET status = 'done', finished_at = ?, outcome = ? WHERE id = ?", [this.now().toISOString(), outcome, w.id]);
      this.bus.emit({ type: "wake.finished", wake_id: w.id, kind: w.kind, outcome });
    } catch (e) {
      const msg = (e as Error).message;
      this.db.run("UPDATE wakes SET status = 'failed', finished_at = ?, error = ? WHERE id = ?", [this.now().toISOString(), msg, w.id]);
      this.log.error("wake.failed", `${w.kind} wake failed: ${msg}`, { stack: (e as Error).stack }, w.id);
      this.bus.emit({ type: "wake.finished", wake_id: w.id, kind: w.kind, outcome: `failed: ${msg}` });
    }
    // System anchors always re-arm.
    if (SYSTEM_ANCHORED.includes(w.kind)) this.ensureSystemWakes();
  }

  /**
   * Time simulation (test profile only): move the clock forward, running
   * each wake at its own due time, so a week plays out in minutes.
   */
  async advanceTo(target: Date, onStep?: (w: Wake) => void): Promise<number> {
    if (!(this.clock instanceof SimClock)) throw new Error("Time simulation only runs on the test profile");
    const clock = this.clock;
    let ran = 0;
    for (let guard = 0; guard < 2000; guard++) {
      const next = this.db.get("SELECT * FROM wakes WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 1", [target.toISOString()]);
      if (!next) break;
      const w = rowToWake(next);
      if (new Date(w.due_at) > clock.now()) clock.set(w.due_at);
      this.bus.emit({ type: "clock.changed", now: clock.now().toISOString() });
      await this.runOne(w);
      await this.afterTick();
      onStep?.(w);
      ran++;
    }
    if (target > clock.now()) clock.set(target);
    this.bus.emit({ type: "clock.changed", now: clock.now().toISOString() });
    await this.afterTick();
    return ran;
  }

  lastSuccessfulWake(): Wake | null {
    const r = this.db.get("SELECT * FROM wakes WHERE status = 'done' ORDER BY finished_at DESC LIMIT 1");
    return r ? rowToWake(r) : null;
  }
}
