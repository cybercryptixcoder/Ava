import { DateTime } from "luxon";
import {
  isClosed,
  parseModuleSpec,
  type HydratedData,
  type HydratedItem,
  type HydratedModule,
  type Item,
  type ModuleSpec,
  type TimelineEntry,
} from "@ava/shared";
import type { Services } from "../core/services";

export type HydrateResult = { ok: true; module: HydratedModule } | { ok: false; errors: string[] };

const DEFAULT_TITLES: Record<ModuleSpec["type"], string> = {
  day_timeline: "Today",
  week_view: "This week",
  task_list: "Tasks",
  options: "Options",
  deadline_horizon: "Coming up",
  project_card: "Project",
  artifact_preview: "Prepared for you",
  comparison_table: "Comparison",
  rule_card: "Rule",
  belief_card: "What I think",
  confirmation_chips: "Changes to confirm",
  note: "Note",
  rhythm_view: "Rhythm",
  chart: "Chart",
};

/**
 * Turns a validated module spec into renderable data drawn from real state.
 * References that don't resolve fail hydration, so the module never renders
 * with invented content.
 */
export class Hydrator {
  constructor(private svc: Services) {}

  private hyd(items: Item[]): HydratedItem[] {
    const { clock, settings, proposals } = this.svc;
    const now = clock.now();
    const tz = settings.tz();
    const projects = new Map(this.svc.items.list({ types: ["project"] }).map((p) => [p.id, p.title]));
    const pending = proposals.pending({ limit: 500 });
    return items.map((i) => {
      const h = this.svc.items.hydrate(i, now, tz, projects);
      const p = pending.find((x) => (x.change as { item_id?: string }).item_id === i.id);
      return p ? { ...h, pending_change: p.summary } : h;
    });
  }

  timeline(date: string, highlight: string[] = []): Extract<HydratedData, { type: "day_timeline" }> {
    const { items, scheduler, settings, clock, db, proposals } = this.svc;
    const tz = settings.tz();
    const s = settings.get();
    const day = DateTime.fromISO(date, { zone: tz });
    const from = day.startOf("day").toJSDate();
    const to = day.endOf("day").toJSDate();
    const entries: TimelineEntry[] = [];
    for (const e of items.list({ types: ["event"], starts_between: [from.toISOString(), to.toISOString()] })) {
      if (e.status === "cancelled") continue;
      entries.push({
        id: e.id,
        kind: "event",
        title: e.title,
        start: e.start_at!,
        end: e.end_at,
        category: (e.data.kind as string) ?? "other",
        item_id: e.id,
        detail: (e.data.location as string) ?? undefined,
        highlighted: highlight.includes(e.id),
      });
    }
    for (const w of scheduler.between(from, to)) {
      if (w.kind === "event") continue;
      entries.push({
        id: w.id,
        kind: "wake",
        title: w.reason,
        start: w.due_at,
        end: null,
        category: w.kind,
        wake_id: w.id,
        status: w.status,
        movable: w.status === "pending" && !["heartbeat", "brief", "evening", "weekly"].includes(w.kind),
        item_id: w.item_ids[0],
      });
    }
    for (const b of db.all<{ id: string; item_id: string | null; title: string; start_at: string; end_at: string; note: string | null; status: string }>(
      "SELECT * FROM plan_blocks WHERE start_at < ? AND end_at > ? AND status != 'cancelled'",
      [to.toISOString(), from.toISOString()],
    )) {
      entries.push({ id: b.id, kind: "plan", title: b.title, start: b.start_at, end: b.end_at, detail: b.note ?? undefined, item_id: b.item_id ?? undefined, status: b.status, highlighted: !!b.item_id && highlight.includes(b.item_id) });
    }
    for (const d of items.list({ open: true, due_after: from.toISOString(), due_before: to.toISOString() }).filter((i) => i.type !== "event")) {
      entries.push({ id: `due_${d.id}`, kind: "deadline", title: d.title, start: d.due_at!, end: null, item_id: d.id, status: d.status, highlighted: highlight.includes(d.id) });
    }
    // Pending reschedules show as ghosts where the item would move to.
    for (const p of proposals.pending({ limit: 200 })) {
      if (p.change.op !== "reschedule") continue;
      const at = p.change.start_at ?? p.change.due_at;
      if (!at) continue;
      const t = new Date(at);
      if (t < from || t > to) continue;
      const it = items.get(p.change.item_id);
      entries.push({ id: `chg_${p.id}`, kind: "pending_change", title: it?.title ?? p.summary, start: t.toISOString(), end: p.change.end_at ?? null, item_id: p.change.item_id, detail: p.summary });
    }
    entries.sort((a, b) => a.start.localeCompare(b.start));
    return {
      type: "day_timeline",
      date: day.toISODate()!,
      tz,
      entries,
      now: clock.now().toISOString(),
      waking: { start: s.quiet_hours.end, end: s.quiet_hours.start },
    };
  }

  private chart(metric: string, days: number, kind: "line" | "bar"): Extract<HydratedData, { type: "chart" }> {
    const { db, settings, clock } = this.svc;
    const tz = settings.tz();
    const end = DateTime.fromJSDate(clock.now()).setZone(tz).endOf("day");
    const start = end.minus({ days: days - 1 }).startOf("day");
    const buckets = new Map<string, number>();
    for (let d = 0; d < days; d++) buckets.set(start.plus({ days: d }).toISODate()!, 0);
    const key = (iso: string) => DateTime.fromISO(iso).setZone(tz).toISODate()!;
    let unit = "";
    if (metric === "tasks_completed") {
      unit = "tasks";
      for (const r of this.svc.items.completionsBetween(start.toUTC().toISO()!, end.toUTC().toISO()!)) {
        const k = key(r.at);
        if (buckets.has(k)) buckets.set(k, buckets.get(k)! + 1);
      }
    } else if (metric === "active_minutes" || metric === "study_minutes") {
      unit = "minutes";
      const rows = db.all<{ started_at: string; active_seconds: number; category: string | null }>(
        "SELECT started_at, active_seconds, category FROM activity_sessions WHERE started_at >= ? AND started_at <= ?",
        [start.toUTC().toISO()!, end.toUTC().toISO()!],
      );
      for (const r of rows) {
        if (metric === "study_minutes" && !["study", "coursework", "reading", "lecture"].includes(r.category ?? "")) continue;
        const k = key(r.started_at);
        if (buckets.has(k)) buckets.set(k, buckets.get(k)! + Math.round(r.active_seconds / 60));
      }
    } else if (metric === "messages_acted_rate") {
      unit = "%";
      const rows = db.all<{ sent_at: string; acted: number | null }>("SELECT sent_at, acted FROM messages WHERE kind = 'nudge' AND sent_at >= ? AND sent_at <= ?", [
        start.toUTC().toISO()!,
        end.toUTC().toISO()!,
      ]);
      const tot = new Map<string, [number, number]>();
      for (const r of rows) {
        const k = key(r.sent_at);
        const [a, n] = tot.get(k) ?? [0, 0];
        tot.set(k, [a + (r.acted ? 1 : 0), n + 1]);
      }
      for (const [k, [a, n]] of tot) if (buckets.has(k)) buckets.set(k, Math.round((a / n) * 100));
    } else if (metric === "open_tasks") {
      unit = "tasks";
      for (const k of buckets.keys()) {
        const dayEnd = DateTime.fromISO(k, { zone: tz }).endOf("day").toUTC().toISO()!;
        const n = db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM items WHERE type = 'task' AND deleted_at IS NULL AND created_at <= ? AND (completed_at IS NULL OR completed_at > ?)",
          [dayEnd, dayEnd],
        );
        buckets.set(k, n?.n ?? 0);
      }
    }
    return { type: "chart", metric, kind, unit, points: Array.from(buckets, ([date, value]) => ({ date, value })) };
  }

  hydrate(input: unknown, meta?: { created_at?: string; updated_at?: string; version?: number; status?: "visible" | "dismissed" }): HydrateResult {
    const parsed = parseModuleSpec(input);
    if (!parsed.ok) return parsed;
    const spec = parsed.spec;
    const { items, clock, settings, rules, beliefs, proposals, executors, rhythms, db } = this.svc;
    const now = clock.now();
    const tz = settings.tz();
    const errors: string[] = [];
    let data: HydratedData | null = null;
    let segments: string[] = [];
    switch (spec.type) {
      case "day_timeline": {
        data = this.timeline(spec.date ?? DateTime.fromJSDate(now).setZone(tz).toISODate()!, spec.highlight_item_ids ?? []);
        segments = data.entries.map((e) => e.id);
        break;
      }
      case "week_view": {
        const start = spec.week_start ? DateTime.fromISO(spec.week_start, { zone: tz }) : DateTime.fromJSDate(now).setZone(tz).startOf("week");
        const days = Array.from({ length: 7 }, (_, d) => {
          const date = start.plus({ days: d }).toISODate()!;
          const t = this.timeline(date);
          return { date, label: start.plus({ days: d }).toFormat("ccc d"), entries: t.entries.filter((e) => e.kind !== "wake") };
        });
        data = { type: "week_view", days, tz, now: now.toISOString() };
        segments = days.map((d) => d.date);
        break;
      }
      case "task_list": {
        let list: Item[];
        if (spec.item_ids) {
          list = items.byIds(spec.item_ids);
          const missing = spec.item_ids.filter((id) => !list.some((i) => i.id === id));
          if (missing.length) errors.push(`Unknown items: ${missing.join(", ")}`);
        } else {
          const f = spec.filter!;
          list = items.list({
            types: f.types ?? ["task", "commitment", "open_loop"],
            statuses: f.statuses,
            project_id: f.project_id,
            tag: f.tag,
            due_before: f.due_within_days !== undefined ? new Date(now.getTime() + f.due_within_days * 86_400_000).toISOString() : undefined,
            open: !f.statuses,
          }).slice(0, 30);
        }
        data = { type: "task_list", items: this.hyd(list) };
        segments = list.map((i) => i.id);
        break;
      }
      case "options": {
        for (const o of spec.options) {
          const a = o.action as { item_id?: string };
          if (a.item_id && !items.get(a.item_id)) errors.push(`Option ${o.key} points at unknown item ${a.item_id}`);
        }
        data = {
          type: "options",
          prompt: spec.prompt ?? null,
          options: spec.options.map((o) => ({ key: o.key, label: o.label, detail: o.detail ?? null, action: o.action })),
          recommended: spec.recommended ?? null,
          chosen: null,
        };
        segments = spec.options.map((o) => o.key);
        break;
      }
      case "deadline_horizon": {
        const days = spec.days ?? 14;
        const list = items
          .list({ open: true, due_after: now.toISOString(), due_before: new Date(now.getTime() + days * 86_400_000).toISOString() })
          .filter((i) => ["task", "commitment"].includes(i.type));
        data = {
          type: "deadline_horizon",
          days,
          now: now.toISOString(),
          items: this.hyd(list).map((h) => ({
            ...h,
            hours_left: Math.round(((new Date(h.due_at!).getTime() - now.getTime()) / 3_600_000) * 10) / 10,
            prep: h.status === "todo" || h.status === "open" ? ("not_started" as const) : h.status === "started" ? ("started" as const) : ["drafted", "almost_done"].includes(h.status) ? ("nearly" as const) : ("done" as const),
          })),
        };
        segments = list.map((i) => i.id);
        break;
      }
      case "project_card": {
        const p = items.get(spec.project_id);
        if (!p || p.type !== "project") {
          errors.push(`No project ${spec.project_id}`);
          break;
        }
        const tasks = items.list({ project_id: p.id }).filter((t) => t.type === "task");
        const loops = items.list({ project_id: p.id }).filter((t) => t.type === "open_loop" && !isClosed(t.type, t.status));
        const [hp] = this.hyd([p]);
        data = {
          type: "project_card",
          project: { ...hp, next_step: (p.data.next_step as string) ?? null, important: p.data.important === true || (p.importance ?? 0) >= 2 },
          tasks: this.hyd(tasks),
          open_loops: this.hyd(loops),
          days_since_touched: Math.floor((now.getTime() - new Date(p.touched_at).getTime()) / 86_400_000),
        };
        break;
      }
      case "artifact_preview": {
        const a = executors.artifact(spec.artifact_id);
        if (!a) errors.push(`No artifact ${spec.artifact_id}`);
        else {
          data = { type: "artifact_preview", artifact: a };
          segments = a.body.kind === "practice_set" ? a.body.questions.map((_q, i) => `q${i + 1}`) : [];
        }
        break;
      }
      case "comparison_table":
        data = { type: "comparison_table", columns: spec.columns, rows: spec.rows, recommended_row: spec.recommended_row ?? null };
        segments = spec.rows.map((r) => r.key);
        break;
      case "rule_card": {
        const r = rules.view(spec.rule_id);
        if (!r) errors.push(`No rule ${spec.rule_id}`);
        else data = { type: "rule_card", rule: r };
        break;
      }
      case "belief_card": {
        const list = spec.belief_ids ? beliefs.list({ ids: spec.belief_ids }) : beliefs.list({ area: spec.area, status: ["active", "proposed"] });
        if (spec.belief_ids && list.length !== spec.belief_ids.length) errors.push("Some beliefs don't exist");
        data = { type: "belief_card", beliefs: list };
        segments = list.map((b) => b.id);
        break;
      }
      case "confirmation_chips": {
        const ps = proposals.batch(spec.batch_id);
        if (!ps.length) errors.push(`No proposals in batch ${spec.batch_id}`);
        data = { type: "confirmation_chips", batch_id: spec.batch_id, proposals: ps };
        segments = ps.map((p) => p.id);
        break;
      }
      case "note": {
        const paragraphs = spec.body
          .split(/\n\s*\n/)
          .map((p) => p.replace(/^\s*[-*•]\s+/gm, "").trim())
          .filter(Boolean);
        data = { type: "note", paragraphs, tone: spec.tone ?? "plain" };
        segments = paragraphs.map((_p, i) => `p${i + 1}`);
        break;
      }
      case "rhythm_view":
        data = rhythms.view(spec.metric, spec.days ?? 28);
        break;
      case "chart":
        data = this.chart(spec.metric, spec.days ?? 14, spec.kind ?? (spec.metric === "messages_acted_rate" ? "line" : "bar"));
        break;
    }
    void db;
    if (errors.length || !data) return { ok: false, errors: errors.length ? errors : ["Could not build this module"] };
    const at = meta?.updated_at ?? now.toISOString();
    return {
      ok: true,
      module: {
        key: spec.key,
        type: spec.type,
        title: spec.title ?? DEFAULT_TITLES[spec.type],
        spec,
        data,
        segments,
        status: meta?.status ?? "visible",
        created_at: meta?.created_at ?? at,
        updated_at: at,
        version: meta?.version ?? 1,
      },
    };
  }
}
