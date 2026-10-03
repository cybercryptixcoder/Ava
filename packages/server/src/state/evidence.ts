import type { Db } from "../db/db";
import { newId } from "../db/db";
import type { Clock } from "../core/clock";
import type { Cipher } from "../security/crypto";

export type EvidenceKind =
  | "transcript"
  | "calendar_event"
  | "conversation_import"
  | "email"
  | "note"
  | "activity_session"
  | "saved_item"
  | "answer"
  | "manual";

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  source: string;
  source_ref: string | null;
  occurred_at: string;
  created_at: string;
  summary: string | null;
  content: unknown;
  distilled_at: string | null;
}

/**
 * Raw evidence store. Everything here is encrypted at rest. Beliefs and
 * items link back to evidence; high-volume raw content is purged after it
 * has been distilled (see retention.ts).
 */
export class EvidenceStore {
  constructor(
    private db: Db,
    private clock: Clock,
    private cipher: Cipher,
  ) {}

  add(e: {
    kind: EvidenceKind;
    source: string;
    content: unknown;
    summary?: string | null;
    occurred_at?: string;
    source_ref?: string | null;
    purge_after?: string | null;
  }): string {
    if (e.source_ref) {
      const existing = this.db.get<{ id: string }>("SELECT id FROM evidence WHERE source = ? AND source_ref = ?", [e.source, e.source_ref]);
      if (existing) return existing.id;
    }
    const id = newId("evd");
    const now = this.clock.now().toISOString();
    this.db.run(
      "INSERT INTO evidence (id, kind, source, source_ref, occurred_at, created_at, summary_enc, content_enc, purge_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        e.kind,
        e.source,
        e.source_ref ?? null,
        e.occurred_at ?? now,
        now,
        e.summary ? this.cipher.encrypt(e.summary) : null,
        this.cipher.encJson(e.content),
        e.purge_after ?? null,
      ],
    );
    return id;
  }

  get(id: string): Evidence | null {
    const r = this.db.get("SELECT * FROM evidence WHERE id = ?", [id]);
    return r ? this.row(r) : null;
  }

  private row(r: Record<string, unknown>): Evidence {
    return {
      id: String(r.id),
      kind: r.kind as EvidenceKind,
      source: String(r.source),
      source_ref: (r.source_ref as string) ?? null,
      occurred_at: String(r.occurred_at),
      created_at: String(r.created_at),
      summary: this.cipher.decOpt(r.summary_enc as string),
      content: this.cipher.decJson(r.content_enc as string, null),
      distilled_at: (r.distilled_at as string) ?? null,
    };
  }

  list(opts: { kind?: EvidenceKind; source?: string; since?: string; limit?: number } = {}): Evidence[] {
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
    if (opts.since) {
      where.push("occurred_at >= ?");
      p.push(opts.since);
    }
    const sql = `SELECT * FROM evidence ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY occurred_at DESC LIMIT ?`;
    return this.db.all(sql, [...p, opts.limit ?? 200]).map((r) => this.row(r));
  }

  markDistilled(id: string): void {
    this.db.run("UPDATE evidence SET distilled_at = ? WHERE id = ?", [this.clock.now().toISOString(), id]);
  }

  linkItem(itemId: string, evidenceId: string): void {
    this.db.run("INSERT OR IGNORE INTO item_evidence (item_id, evidence_id) VALUES (?, ?)", [itemId, evidenceId]);
  }

  /**
   * Drop raw content once its purge time has passed and it has been distilled.
   * Text records of his words and Ava's replies — voice transcripts, chat
   * imports, sent mail, Wispr notes, question answers — never purge: they are
   * the memory. Only activity samples and other raw third-party content move
   * through here. Keeps the summary.
   */
  purgeDue(now: Date): number {
    const r = this.db.run(
      "UPDATE evidence SET content_enc = ?, purge_after = NULL WHERE purge_after IS NOT NULL AND purge_after <= ? AND distilled_at IS NOT NULL AND kind NOT IN ('transcript','conversation_import','email','note','answer')",
      [this.cipher.encJson({ purged: true }), now.toISOString()],
    );
    return r.changes;
  }

  deleteBySource(source: string): number {
    this.db.run("DELETE FROM item_evidence WHERE evidence_id IN (SELECT id FROM evidence WHERE source = ?)", [source]);
    this.db.run("DELETE FROM belief_evidence WHERE evidence_id IN (SELECT id FROM evidence WHERE source = ?)", [source]);
    return this.db.run("DELETE FROM evidence WHERE source = ?", [source]).changes;
  }
}
