import type { MessageOption, MessageView, ResponseKind } from "@ava/shared";
import type { Db } from "../db/db";
import { j, js, newId } from "../db/db";
import type { Clock } from "../core/clock";
import type { ItemStore } from "../state/items";
import type { RuleStore } from "../rules/store";

export interface NewMessage {
  kind: MessageView["kind"];
  rule_id: string | null;
  wake_id: string | null;
  headline: string;
  because_template?: string | null;
  because: string;
  cited: string[];
  options: MessageOption[];
  urgency: MessageView["urgency"];
  status: MessageView["status"];
  block_reason?: string | null;
  dedupe_key?: string | null;
  drafted_by: MessageView["drafted_by"];
}

export class MessageStore {
  constructor(
    private db: Db,
    private clock: Clock,
    private items: ItemStore,
    private rules: RuleStore,
  ) {}

  create(m: NewMessage): MessageView {
    const id = newId("msg");
    const now = this.clock.now().toISOString();
    this.db.run(
      `INSERT INTO messages (id, kind, rule_id, wake_id, headline, because_template, because, cited, options, urgency, status, block_reason, dedupe_key, drafted_by, created_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        m.kind,
        m.rule_id,
        m.wake_id,
        m.headline,
        m.because_template ?? null,
        m.because,
        js(m.cited),
        js(m.options),
        m.urgency,
        m.status,
        m.block_reason ?? null,
        m.dedupe_key ?? null,
        m.drafted_by,
        now,
        m.status === "sent" ? now : null,
      ],
    );
    return this.get(id)!;
  }

  private row(r: Record<string, unknown>): MessageView {
    const cited: string[] = j(r.cited, []);
    const items = this.items.byIds(cited);
    return {
      id: String(r.id),
      kind: r.kind as MessageView["kind"],
      rule_id: (r.rule_id as string) ?? null,
      rule_name: r.rule_id ? (this.rules.row(String(r.rule_id))?.name ?? null) : null,
      headline: String(r.headline),
      because: String(r.because),
      cited: cited.map((id) => {
        const it = items.find((i) => i.id === id);
        return { id, title: it?.title ?? "(removed item)", type: it?.type ?? "unknown" };
      }),
      options: j(r.options, []),
      urgency: r.urgency as MessageView["urgency"],
      status: r.status as MessageView["status"],
      block_reason: (r.block_reason as string) ?? null,
      created_at: String(r.created_at),
      sent_at: (r.sent_at as string) ?? null,
      response: (r.response as ResponseKind) ?? null,
      response_option: (r.response_option as string) ?? null,
      responded_at: (r.responded_at as string) ?? null,
      acted: r.acted === null || r.acted === undefined ? null : !!r.acted,
      wake_id: (r.wake_id as string) ?? null,
      drafted_by: r.drafted_by as MessageView["drafted_by"],
    };
  }

  get(id: string): MessageView | null {
    const r = this.db.get("SELECT * FROM messages WHERE id = ?", [id]);
    return r ? this.row(r) : null;
  }

  list(opts: { limit?: number; status?: string[]; kinds?: string[]; since?: string } = {}): MessageView[] {
    const where: string[] = [];
    const p: (string | number)[] = [];
    if (opts.status?.length) {
      where.push(`status IN (${opts.status.map(() => "?").join(",")})`);
      p.push(...opts.status);
    }
    if (opts.kinds?.length) {
      where.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`);
      p.push(...opts.kinds);
    }
    if (opts.since) {
      where.push("created_at >= ?");
      p.push(opts.since);
    }
    return this.db
      .all(`SELECT * FROM messages ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`, [...p, opts.limit ?? 100])
      .map((r) => this.row(r));
  }

  queuedForBrief(): MessageView[] {
    return this.db.all("SELECT * FROM messages WHERE status = 'queued' ORDER BY created_at").map((r) => this.row(r));
  }

  markInBrief(ids: string[]): void {
    const now = this.clock.now().toISOString();
    for (const id of ids) this.db.run("UPDATE messages SET status = 'in_brief', sent_at = ? WHERE id = ? AND status = 'queued'", [now, id]);
  }

  recentlySent(dedupeKey: string, hours: number): boolean {
    const since = new Date(this.clock.now().getTime() - hours * 3_600_000).toISOString();
    return !!this.db.get("SELECT id FROM messages WHERE dedupe_key = ? AND created_at >= ? AND status IN ('sent','queued','in_brief')", [dedupeKey, since]);
  }

  recordResponse(id: string, response: ResponseKind, option: string | null, acted: boolean): MessageView {
    this.db.run("UPDATE messages SET response = ?, response_option = ?, responded_at = ?, acted = ? WHERE id = ?", [
      response,
      option,
      this.clock.now().toISOString(),
      acted ? 1 : 0,
      id,
    ]);
    return this.get(id)!;
  }

  /** A cited item moved forward soon after a nudge without a tap: that counts as acting on it. */
  markActedFromItem(itemId: string): string[] {
    const since = new Date(this.clock.now().getTime() - 24 * 3_600_000).toISOString();
    const rows = this.db.all<{ id: string; cited: string }>(
      "SELECT id, cited FROM messages WHERE created_at >= ? AND response IS NULL AND acted IS NULL AND status IN ('sent','in_brief')",
      [since],
    );
    const hit = rows.filter((r) => j<string[]>(r.cited, []).includes(itemId)).map((r) => r.id);
    for (const id of hit) this.db.run("UPDATE messages SET acted = 1 WHERE id = ?", [id]);
    return hit;
  }

  sentToday(fromIso: string): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE kind = 'nudge' AND status = 'sent' AND sent_at >= ?", [fromIso])?.n ?? 0;
  }
}
