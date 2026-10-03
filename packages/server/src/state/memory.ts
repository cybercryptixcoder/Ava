import type { Db } from "../db/db";
import { newId } from "../db/db";
import type { Clock } from "../core/clock";
import type { Cipher } from "../security/crypto";

/**
 * L0, the raw log: one unified append-only record of everything Shreyas says
 * to Ava and everything Ava says back, across every source, with a stable id.
 * Summaries, facts and indexes derive from it and point back into it; they
 * never replace it. The only operation that ever touches a stored text is the
 * explicit forget flow, which blanks the text and leaves a content-free
 * tombstone naming the reason. Operational meta (an audio pointer attached
 * after speaking, for example) may be filled in once; verbatim text never
 * changes.
 */

export type EntryKind = "turn" | "transcript" | "import" | "sent_mail" | "item_event" | "card_response" | "artifact" | "answer";

export interface Entry {
  id: string;
  kind: EntryKind;
  source: string;
  role: string | null;
  session_id: string | null;
  occurred_at: string;
  recorded_at: string;
  text: string;
  /** The stored raw form (Ava's replies keep their canvas directives here). */
  raw: string | null;
  meta: Record<string, unknown>;
  deleted_at: string | null;
  deleted_reason: string | null;
}

export interface EntryLink {
  entry_id: string;
  rel: string;
  target_kind: string;
  target_id: string;
  created_at: string;
}

export interface AppendedEntry {
  id: string;
  kind: EntryKind;
  source: string;
  text: string;
  occurred_at: string;
}

export class MemoryStore {
  private appended: ((e: AppendedEntry) => void)[] = [];
  private forgotten: ((ids: string[]) => void)[] = [];

  constructor(
    private db: Db,
    private clock: Clock,
    private cipher: Cipher,
  ) {}

  /** Listeners fire after every append — the derived layers watch the log, not the writers. */
  onAppend(fn: (e: AppendedEntry) => void): void {
    this.appended.push(fn);
  }

  /** Listeners fire when the explicit forget flow blanks entries. */
  onForget(fn: (ids: string[]) => void): void {
    this.forgotten.push(fn);
  }

  /** Entry ids covered by an episode, in order. */
  episodeEntries(episodeId: string): string[] {
    return this.db.all<{ entry_id: string }>("SELECT entry_id FROM episode_entries WHERE episode_id = ? ORDER BY position, entry_id", [episodeId]).map((r) => r.entry_id);
  }

  /**
   * Append one entry. This is the only write to the log; everything else in
   * the codebase reads. `id` may be pre-set when copying older data so ids
   * stay stable across the migration.
   */
  append(e: {
    kind: EntryKind;
    source: string;
    text: string;
    role?: string | null;
    session_id?: string | null;
    occurred_at?: string | null;
    meta?: Record<string, unknown>;
    raw?: string | null;
    id?: string;
  }): string {
    const id = e.id ?? newId("ent");
    const now = this.clock.now().toISOString();
    this.db.run(
      "INSERT INTO entries (id, kind, source, role, session_id, occurred_at, recorded_at, text_enc, raw_enc, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        e.kind,
        e.source,
        e.role ?? null,
        e.session_id ?? null,
        e.occurred_at ?? now,
        now,
        this.cipher.encrypt(e.text),
        e.raw ? this.cipher.encrypt(e.raw) : null,
        JSON.stringify(e.meta ?? {}),
      ],
    );
    for (const fn of this.appended) {
      try {
        fn({ id, kind: e.kind, source: e.source, text: e.text, occurred_at: e.occurred_at ?? now });
      } catch {
        /* watchers are best-effort; the log entry is already safe */
      }
    }
    return id;
  }

  get(id: string): Entry | null {
    const r = this.db.get("SELECT * FROM entries WHERE id = ?", [id]);
    return r ? this.row(r) : null;
  }

  list(
    opts: { kind?: EntryKind; source?: string; session?: string; role?: string; since?: string; until?: string; limit?: number; order?: "asc" | "desc"; includeDeleted?: boolean } = {},
  ): Entry[] {
    const where: string[] = [];
    const p: (string | number)[] = [];
    if (opts.kind) {
      where.push("kind = ?");
      p.push(opts.kind);
    }
    if (opts.source) {
      where.push("source = ?");
      p.push(opts.source);
    }
    if (opts.session) {
      where.push("session_id = ?");
      p.push(opts.session);
    }
    if (opts.role) {
      where.push("role = ?");
      p.push(opts.role);
    }
    if (opts.since) {
      where.push("occurred_at >= ?");
      p.push(opts.since);
    }
    if (opts.until) {
      where.push("occurred_at < ?");
      p.push(opts.until);
    }
    if (!opts.includeDeleted) where.push("deleted_at IS NULL");
    const dir = opts.order ?? "asc";
    const sql = `SELECT * FROM entries ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY occurred_at ${dir}, rowid ${dir} LIMIT ?`;
    return this.db.all(sql, [...p, opts.limit ?? 200]).map((r) => this.row(r));
  }

  count(opts: { kind?: EntryKind; source?: string; session?: string } = {}): number {
    const where: string[] = [];
    const p: string[] = [];
    if (opts.kind) {
      where.push("kind = ?");
      p.push(opts.kind);
    }
    if (opts.source) {
      where.push("source = ?");
      p.push(opts.source);
    }
    if (opts.session) {
      where.push("session_id = ?");
      p.push(opts.session);
    }
    return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM entries ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`, p)?.n ?? 0;
  }

  countByKind(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.all<{ kind: string; n: number }>("SELECT kind, COUNT(*) AS n FROM entries WHERE deleted_at IS NULL GROUP BY kind ORDER BY kind")) out[r.kind] = r.n;
    return out;
  }

  // ------------------------------------------------------------------ links

  /** Record what an entry was about or touched. Recorded from day one. */
  link(entryId: string, rel: string, targetKind: string, targetId: string): void {
    this.db.run("INSERT OR IGNORE INTO entry_links (entry_id, rel, target_kind, target_id, created_at) VALUES (?, ?, ?, ?, ?)", [
      entryId,
      rel,
      targetKind,
      targetId,
      this.clock.now().toISOString(),
    ]);
  }

  linksOf(entryId: string): EntryLink[] {
    return this.db.all<EntryLink>("SELECT entry_id, rel, target_kind, target_id, created_at FROM entry_links WHERE entry_id = ? ORDER BY created_at", [entryId]);
  }

  linksTo(targetKind: string, targetId: string, rel?: string): EntryLink[] {
    if (rel) return this.db.all<EntryLink>("SELECT * FROM entry_links WHERE target_kind = ? AND target_id = ? AND rel = ? ORDER BY created_at", [targetKind, targetId, rel]);
    return this.db.all<EntryLink>("SELECT * FROM entry_links WHERE target_kind = ? AND target_id = ? ORDER BY created_at", [targetKind, targetId]);
  }

  /** Entry ids linked to a target (what items/threads/cards an entry touched). */
  entriesFor(targetKind: string, targetId: string): string[] {
    return this.db.all<{ entry_id: string }>("SELECT DISTINCT entry_id FROM entry_links WHERE target_kind = ? AND target_id = ? ORDER BY entry_id", [targetKind, targetId]).map((r) => r.entry_id);
  }

  // ----------------------------------------------------------------- forget

  /**
   * The one deliberate exception to append-only: forget blanks the stored text
   * and leaves a content-free tombstone. Called only from the explicit
   * forget flows after his confirmation.
   */
  forget(ids: string[], reason: string): number {
    const now = this.clock.now().toISOString();
    let n = 0;
    const done: string[] = [];
    for (const id of ids) {
      const changed = this.db.run("UPDATE entries SET text_enc = '', raw_enc = NULL, meta = '{}', deleted_at = ?, deleted_reason = ? WHERE id = ? AND deleted_at IS NULL", [now, reason, id]).changes;
      if (changed) done.push(id);
      n += changed;
    }
    if (n) {
      const seen = [...new Set(ids.filter((id) => done.includes(id)))];
      for (const fn of this.forgotten) {
        try {
          fn(seen);
        } catch {
          /* watchers are best-effort */
        }
      }
      this.logForget(ids.length, reason);
    }
    return n;
  }

  forgetBySource(source: string, reason: string): number {
    const ids = this.db.all<{ id: string }>("SELECT id FROM entries WHERE source = ? AND deleted_at IS NULL", [source]).map((r) => r.id);
    return this.forget(ids, reason);
  }

  private logForget(count: number, reason: string): void {
    this.db.run("INSERT INTO log (at, kind, level, summary, data) VALUES (?, 'memory.forget', 'info', ?, ?)", [
      this.clock.now().toISOString(),
      `Forgot ${count} raw ${count === 1 ? "entry" : "entries"}: ${reason}`,
      JSON.stringify({ reason }),
    ]);
  }

  // ------------------------------------------------------- operational meta

  /** Fill in operational meta that only exists after the fact (audio pointers). The verbatim text never changes. */
  mergeMeta(id: string, patch: Record<string, unknown>): void {
    const r = this.db.get<{ meta: string }>("SELECT meta FROM entries WHERE id = ?", [id]);
    if (!r) return;
    this.db.run("UPDATE entries SET meta = ? WHERE id = ?", [JSON.stringify({ ...JSON.parse(r.meta), ...patch }), id]);
  }

  // ------------------------------------------------------------ bookkeeping

  getState<T = unknown>(key: string): T | null {
    const r = this.db.get<{ value: string }>("SELECT value FROM memory_state WHERE key = ?", [key]);
    return r ? (JSON.parse(r.value) as T) : null;
  }

  setState(key: string, value: unknown): void {
    this.db.run("INSERT INTO memory_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [
      key,
      JSON.stringify(value),
      this.clock.now().toISOString(),
    ]);
  }

  private row(r: Record<string, unknown>): Entry {
    return {
      id: String(r.id),
      kind: r.kind as EntryKind,
      source: String(r.source),
      role: (r.role as string) ?? null,
      session_id: (r.session_id as string) ?? null,
      occurred_at: String(r.occurred_at),
      recorded_at: String(r.recorded_at),
      text: this.cipher.decOpt(r.text_enc as string) ?? "",
      raw: this.cipher.decOpt(r.raw_enc as string),
      meta: r.meta ? (JSON.parse(String(r.meta)) as Record<string, unknown>) : {},
      deleted_at: (r.deleted_at as string) ?? null,
      deleted_reason: (r.deleted_reason as string) ?? null,
    };
  }
}
