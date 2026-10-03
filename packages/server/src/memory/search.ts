import { DatabaseSync } from "node:sqlite";
import type { Services } from "../core/services";

/**
 * Search over the raw log and its derived layers, entirely in memory.
 *
 * Sensitive text is encrypted field-by-field in the database, so a search
 * index can't live there without storing plaintext on disk. Instead the
 * index is built at startup from decrypted rows into an in-memory SQLite
 * FTS5 database: nothing searchable ever touches the disk, and the rebuild
 * at personal scale costs milliseconds. After the first build, appends,
 * processed episodes/facts and forgets update the index incrementally; a
 * full rebuild happens on demand (markStale after bulk copies).
 *
 * Embeddings (semantic search) merge into the same hit list in a later
 * stage; this file owns the keyword path and the ranking interface.
 */

export type RefKind = "entry" | "episode" | "fact";

export interface Hit {
  ref_kind: RefKind;
  ref_id: string;
  /** Higher is better. Keyword scores are normalized so the best hit is 1. */
  score: number;
  at: string;
  importance: number;
}

export interface SearchOpts {
  kinds?: RefKind[];
  since?: string;
  until?: string;
  limit?: number;
}

const STOP = new Set(
  "a an and are as at be but by for from has have he her his i if in is it its me my of on or our she that the their them then there these they this to was we were what when where which who why will with you your".split(" "),
);

/** Turn free text into an FTS5 MATCH expression that can't be a syntax error. */
export function toMatch(query: string, maxTerms = 12): string {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}'-]+/u)
    .map((t) => t.replace(/^['-]+|['-]+$/g, ""))
    .filter((t) => t.length >= 2 && !STOP.has(t))
    .slice(0, maxTerms);
  if (!terms.length) return "";
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

export class MemorySearch {
  private db: DatabaseSync | null = null;

  constructor(private svc: Services) {}

  /** Drop the index; the next search rebuilds from current rows. */
  markStale(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private ensure(): DatabaseSync {
    if (this.db) return this.db;
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE VIRTUAL TABLE entries_fts USING fts5(ref UNINDEXED, text, at UNINDEXED, importance UNINDEXED);
      CREATE VIRTUAL TABLE episodes_fts USING fts5(ref UNINDEXED, text, at UNINDEXED, importance UNINDEXED);
      CREATE VIRTUAL TABLE facts_fts USING fts5(ref UNINDEXED, text, at UNINDEXED, importance UNINDEXED);
    `);
    const { db: src, cipher } = this.svc;
    db.exec("BEGIN");
    for (const r of src.all<Record<string, unknown>>("SELECT id, text_enc, occurred_at FROM entries WHERE deleted_at IS NULL")) {
      this.insert(db, "entries", String(r.id), cipher.decOpt(r.text_enc as string) ?? "", String(r.occurred_at), 0.5);
    }
    for (const r of src.all<Record<string, unknown>>("SELECT id, gist_enc, keywords_enc, entities_enc, start_at, importance FROM episodes")) {
      const text = [cipher.decOpt(r.gist_enc as string) ?? "", (cipher.decJson(r.keywords_enc as string, []) as string[]).join(", "), (cipher.decJson(r.entities_enc as string, []) as string[]).join(", ")].filter(Boolean).join("\n");
      this.insert(db, "episodes", String(r.id), text, String(r.start_at), Number(r.importance ?? 0));
    }
    for (const r of src.all<Record<string, unknown>>("SELECT id, statement_enc, keywords_enc, entities_enc, recorded_at, importance FROM facts WHERE status != 'removed'")) {
      const text = [cipher.decOpt(r.statement_enc as string) ?? "", (cipher.decJson(r.keywords_enc as string, []) as string[]).join(", "), (cipher.decJson(r.entities_enc as string, []) as string[]).join(", ")].filter(Boolean).join("\n");
      this.insert(db, "facts", String(r.id), text, String(r.recorded_at), Number(r.importance ?? 0.5));
    }
    db.exec("COMMIT");
    this.db = db;
    return db;
  }

  private insert(db: DatabaseSync, table: string, ref: string, text: string, at: string, importance: number): void {
    if (!text.trim()) return;
    db.prepare(`INSERT INTO ${table}_fts (ref, text, at, importance) VALUES (?, ?, ?, ?)`).run(ref, text, at, importance);
  }

  /** Index one entry right after it's appended (if the index is alive). */
  indexEntry(e: { id: string; text: string; occurred_at: string; deleted?: boolean }): void {
    if (!this.db) return;
    this.db.prepare("DELETE FROM entries_fts WHERE ref = ?").run(e.id);
    if (!e.deleted) this.insert(this.db, "entries", e.id, e.text, e.occurred_at, 0.5);
  }

  indexEpisode(id: string): void {
    if (!this.db) return;
    const { db: src, cipher } = this.svc;
    const r = src.get<Record<string, unknown>>("SELECT id, gist_enc, keywords_enc, entities_enc, start_at, importance FROM episodes WHERE id = ?", [id]);
    this.db.prepare("DELETE FROM episodes_fts WHERE ref = ?").run(id);
    if (r) {
      const text = [cipher.decOpt(r.gist_enc as string) ?? "", (cipher.decJson(r.keywords_enc as string, []) as string[]).join(", "), (cipher.decJson(r.entities_enc as string, []) as string[]).join(", ")].filter(Boolean).join("\n");
      this.insert(this.db, "episodes", id, text, String(r.start_at), Number(r.importance ?? 0));
    }
  }

  indexFact(id: string): void {
    if (!this.db) return;
    const { db: src, cipher } = this.svc;
    const r = src.get<Record<string, unknown>>("SELECT id, statement_enc, keywords_enc, entities_enc, recorded_at, importance FROM facts WHERE id = ?", [id]);
    this.db.prepare("DELETE FROM facts_fts WHERE ref = ?").run(id);
    if (r) {
      const text = [cipher.decOpt(r.statement_enc as string) ?? "", (cipher.decJson(r.keywords_enc as string, []) as string[]).join(", "), (cipher.decJson(r.entities_enc as string, []) as string[]).join(", ")].filter(Boolean).join("\n");
      this.insert(this.db, "facts", id, text, String(r.recorded_at), Number(r.importance ?? 0.5));
    }
  }

  removeRef(kind: RefKind, id: string): void {
    if (!this.db) return;
    const table = `${kind === "entry" ? "entries" : kind === "episode" ? "episodes" : "facts"}_fts`;
    this.db.prepare(`DELETE FROM ${table} WHERE ref = ?`).run(id);
  }

  /** Keyword hits across the requested layers, best first. */
  search(query: string, opts: SearchOpts = {}): Hit[] {
    const match = toMatch(query);
    if (!match) return [];
    const db = this.ensure();
    const kinds = opts.kinds ?? (["episode", "fact", "entry"] as RefKind[]);
    const out: Hit[] = [];
    for (const k of kinds) {
      const table = `${k === "entry" ? "entries" : k === "episode" ? "episodes" : "facts"}_fts`;
      const rows = db.prepare(`SELECT ref, at, importance, -bm25(${table}) AS s FROM ${table} WHERE ${table} MATCH ? ORDER BY bm25(${table}) LIMIT 60`).all(match) as { ref: string; at: string; importance: number; s: number }[];
      for (const r of rows) out.push({ ref_kind: k, ref_id: r.ref, score: r.s, at: r.at, importance: Number(r.importance) });
    }
    let hits = out;
    if (opts.since || opts.until) {
      const since = opts.since ? Date.parse(opts.since) : -Infinity;
      const until = opts.until ? Date.parse(opts.until) : Infinity;
      hits = hits.filter((h) => {
        const t = Date.parse(h.at);
        return t >= since && t < until;
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, opts.limit ?? 24);
  }
}
