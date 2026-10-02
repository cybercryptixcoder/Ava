import type { LogEntry } from "@ava/shared";
import type { Db } from "../db/db";
import { j, js } from "../db/db";
import type { Clock } from "./clock";
import type { EventBus } from "./events";

/**
 * The decision log. Every wake, rule evaluation, model call, validator
 * decision, message and response lands here in plain language, so it is
 * always possible to see why Ava did or didn't reach out.
 */
export class DecisionLog {
  constructor(
    private db: Db,
    private clock: Clock,
    private bus?: EventBus,
  ) {}

  write(kind: string, summary: string, opts: { wakeId?: string | null; data?: unknown; level?: "info" | "warn" | "error" } = {}): number {
    const r = this.db.run("INSERT INTO log (at, wake_id, kind, level, summary, data) VALUES (?, ?, ?, ?, ?, ?)", [
      this.clock.now().toISOString(),
      opts.wakeId ?? null,
      kind,
      opts.level ?? "info",
      summary,
      opts.data === undefined ? null : js(opts.data),
    ]);
    const id = Number(r.lastInsertRowid);
    this.bus?.emit({ type: "log", id, kind, summary });
    return id;
  }

  info(kind: string, summary: string, data?: unknown, wakeId?: string | null) {
    return this.write(kind, summary, { data, wakeId });
  }
  warn(kind: string, summary: string, data?: unknown, wakeId?: string | null) {
    return this.write(kind, summary, { data, wakeId, level: "warn" });
  }
  error(kind: string, summary: string, data?: unknown, wakeId?: string | null) {
    return this.write(kind, summary, { data, wakeId, level: "error" });
  }

  list(opts: { limit?: number; before?: number; wakeId?: string; kind?: string; q?: string } = {}): LogEntry[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.before) {
      where.push("id < ?");
      params.push(opts.before);
    }
    if (opts.wakeId) {
      where.push("wake_id = ?");
      params.push(opts.wakeId);
    }
    if (opts.kind) {
      where.push("kind LIKE ?");
      params.push(`${opts.kind}%`);
    }
    if (opts.q) {
      where.push("summary LIKE ?");
      params.push(`%${opts.q}%`);
    }
    const sql = `SELECT * FROM log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
    params.push(Math.min(opts.limit ?? 200, 1000));
    return this.db.all<Record<string, unknown>>(sql, params).map((r) => ({
      id: Number(r.id),
      at: String(r.at),
      wake_id: (r.wake_id as string) ?? null,
      kind: String(r.kind),
      summary: String(r.summary),
      level: r.level as LogEntry["level"],
      data: j(r.data, null),
    }));
  }
}
