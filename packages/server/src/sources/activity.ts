import { z } from "zod";
import type { Services } from "../core/services";
import { newId } from "../db/db";
import { itemLine } from "../planner/context";
import type { SourcePlugin } from "./types";

export const SessionInputSchema = z.object({
  device: z.string().min(1).max(80),
  sessions: z
    .array(
      z.object({
        app: z.string().min(1).max(200),
        title: z.string().max(500).optional(),
        started_at: z.string(),
        ended_at: z.string(),
        active_seconds: z.number().int().min(0),
      }),
    )
    .max(500),
});

const LabelOutput = z.object({
  labels: z.array(
    z.object({
      session: z.number().int(),
      label: z.string(),
      category: z.enum(["study", "coursework", "reading", "work", "coding", "writing", "research", "admin", "communication", "entertainment", "social", "other"]),
      item_id: z.string().nullable(),
    }),
  ),
});

/**
 * Laptop activity. The local collector samples the active window, merges
 * samples into sessions on the laptop, and sends only sessions. Here the
 * stages continue: model labeling of merged sessions, statistics for
 * rhythms, and finally belief proposals with evidence. Raw window titles are
 * dropped after a short retention period once labeled. Off by default.
 */
export class ActivitySource implements SourcePlugin {
  readonly id = "activity";
  readonly label = "Laptop activity";
  readonly description = "A small collector on your laptop sends merged app sessions (never raw samples) so Ava knows when you're free and what's already started.";
  readonly defaultOn = false;
  readonly pollEveryMinutes = 60;

  constructor(private svc: Services) {}

  configured(): boolean {
    return !!this.svc.cfg.collectorToken;
  }
  needs(): string | null {
    return this.configured() ? (this.connected() ? null : "Install and run the collector") : "Set COLLECTOR_TOKEN";
  }
  connected(): boolean {
    return !!this.svc.db.get("SELECT id FROM activity_sessions LIMIT 1");
  }

  ingest(input: z.infer<typeof SessionInputSchema>): number {
    const { db, cipher, clock, settings } = this.svc;
    const purge = new Date(clock.now().getTime() + settings.get().retention.raw_activity_days * 86_400_000).toISOString();
    let n = 0;
    for (const s of input.sessions) {
      const start = new Date(s.started_at);
      const end = new Date(s.ended_at);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) continue;
      const dup = db.get("SELECT id FROM activity_sessions WHERE device = ? AND started_at = ? AND app = ?", [input.device, start.toISOString(), s.app]);
      if (dup) continue;
      db.run(
        "INSERT INTO activity_sessions (id, device, app, title_enc, started_at, ended_at, active_seconds, purge_title_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [newId("act"), input.device, s.app, s.title ? cipher.encrypt(s.title) : null, start.toISOString(), end.toISOString(), s.active_seconds, purge],
      );
      n++;
    }
    return n;
  }

  /** Stage 2: label merged sessions with the model, link to items, propose "started" chips. */
  async poll(wakeId: string | null): Promise<string> {
    const { db, cipher, models, cfg, items, proposals, log, clock } = this.svc;
    const purged = db.run("UPDATE activity_sessions SET title_enc = NULL WHERE title_enc IS NOT NULL AND labeled_at IS NOT NULL AND purge_title_after <= ?", [clock.now().toISOString()]).changes;
    const rows = db.all<{ id: string; app: string; title_enc: string | null; started_at: string; ended_at: string; active_seconds: number }>(
      "SELECT * FROM activity_sessions WHERE labeled_at IS NULL AND active_seconds >= 120 ORDER BY started_at LIMIT 60",
    );
    if (!rows.length || !models.available) return `${purged} titles purged; nothing to label`;
    const open = items.list({ open: true }).filter((i) => ["task", "project"].includes(i.type));
    const res = await models.complete({
      purpose: "activity.label",
      origin: "system",
      model: cfg.models.fast,
      maxTokens: 3000,
      wakeId,
      schema: LabelOutput,
      system:
        "Label laptop sessions (app + window title) with a short activity label and a category, and link a session to one of the open items only when the title clearly shows work on it. Don't speculate about how he feels.",
      messages: [
        {
          role: "user",
          content: `Open items:\n${open.map((i) => itemLine(this.svc, i)).join("\n")}\n\nSessions:\n${rows
            .map((r, i) => `${i}: ${r.app} — "${cipher.decOpt(r.title_enc) ?? ""}" (${Math.round(r.active_seconds / 60)} min active)`)
            .join("\n")}`,
        },
      ],
    });
    const now = clock.now().toISOString();
    let linked = 0;
    const started: { item_id: string; minutes: number }[] = [];
    for (const l of res.parsed?.labels ?? []) {
      const r = rows[l.session];
      if (!r) continue;
      const item = l.item_id ? items.get(l.item_id) : null;
      db.run("UPDATE activity_sessions SET label = ?, category = ?, item_id = ?, labeled_at = ? WHERE id = ?", [l.label, l.category, item?.id ?? null, now, r.id]);
      if (item) {
        linked++;
        items.touch(item.id, new Date(r.ended_at));
        if (item.type === "task" && item.status === "todo") started.push({ item_id: item.id, minutes: Math.round(r.active_seconds / 60) });
      }
    }
    for (const r of rows) db.run("UPDATE activity_sessions SET labeled_at = COALESCE(labeled_at, ?) WHERE id = ?", [now, r.id]);
    const byItem = new Map<string, number>();
    for (const s of started) byItem.set(s.item_id, (byItem.get(s.item_id) ?? 0) + s.minutes);
    const already = new Set(proposals.pending({ origin: this.id }).map((p) => (p.change as { item_id?: string }).item_id));
    const chips = [...byItem]
      .filter(([id]) => !already.has(id))
      .map(([id, minutes]) => ({
        change: { op: "set_status" as const, item_id: id, status: "started" },
        summary: `Looks like you started ${items.get(id)!.title} (${minutes} min on the laptop)`,
        reason: "From labeled laptop sessions",
      }));
    if (chips.length) proposals.createBatch(this.id, chips);
    log.info("source.activity", `Labeled ${rows.length} sessions, ${linked} linked to items, ${chips.length} "started" proposals, ${purged} raw titles purged`, undefined, wakeId);
    return `${rows.length} labeled`;
  }

  recent(limit = 50): { id: string; app: string; label: string | null; category: string | null; started_at: string; ended_at: string; active_seconds: number; item_id: string | null }[] {
    return this.svc.db.all("SELECT id, app, label, category, started_at, ended_at, active_seconds, item_id FROM activity_sessions ORDER BY started_at DESC LIMIT ?", [limit]);
  }

  stats(): Record<string, number> {
    const r = this.svc.db.get<{ n: number; m: number | null }>("SELECT COUNT(*) AS n, SUM(active_seconds) AS m FROM activity_sessions");
    return { sessions: r?.n ?? 0, active_hours: Math.round((r?.m ?? 0) / 360) / 10 };
  }

  deleteData(): number {
    this.svc.db.run("DELETE FROM items WHERE type = 'rhythm'");
    return this.svc.db.run("DELETE FROM activity_sessions").changes;
  }
}
