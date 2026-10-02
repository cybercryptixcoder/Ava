import type { Belief, Provenance } from "@ava/shared";
import type { Db } from "../db/db";
import { newId } from "../db/db";
import type { Clock } from "../core/clock";

/**
 * Beliefs: what Ava thinks is true about Shreyas and his world. Each carries
 * provenance, confidence, evidence links and when it was last confirmed.
 * Confidence decays with a half-life unless refreshed; stated beliefs decay
 * at half the rate. Inferred beliefs stay proposals until confirmed.
 */
export class BeliefStore {
  constructor(
    private db: Db,
    private clock: Clock,
    private halfLifeDays: () => number,
  ) {}

  private row(r: Record<string, unknown>, evidence: string[]): Belief {
    const confidence = Number(r.confidence);
    const anchor = (r.last_confirmed_at as string) ?? String(r.created_at);
    const days = Math.max(0, (this.clock.now().getTime() - new Date(anchor).getTime()) / 86_400_000);
    const hl = this.halfLifeDays() * (r.provenance === "stated" ? 2 : 1);
    const effective = confidence * Math.pow(0.5, days / hl);
    return {
      id: String(r.id),
      area: String(r.area),
      statement: String(r.statement),
      subject_item_id: (r.subject_item_id as string) ?? null,
      provenance: r.provenance as Provenance,
      confidence,
      effective_confidence: Math.round(effective * 1000) / 1000,
      status: r.status as Belief["status"],
      last_confirmed_at: (r.last_confirmed_at as string) ?? null,
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
      evidence_ids: evidence,
    };
  }

  private evidenceFor(ids: string[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    if (!ids.length) return map;
    for (const r of this.db.all<{ belief_id: string; evidence_id: string }>(
      `SELECT belief_id, evidence_id FROM belief_evidence WHERE belief_id IN (${ids.map(() => "?").join(",")})`,
      ids,
    )) {
      map.set(r.belief_id, [...(map.get(r.belief_id) ?? []), r.evidence_id]);
    }
    return map;
  }

  list(opts: { status?: Belief["status"][]; area?: string; ids?: string[] } = {}): Belief[] {
    const where: string[] = [];
    const p: string[] = [];
    if (opts.status?.length) {
      where.push(`status IN (${opts.status.map(() => "?").join(",")})`);
      p.push(...opts.status);
    }
    if (opts.area) {
      where.push("area = ?");
      p.push(opts.area);
    }
    if (opts.ids?.length) {
      where.push(`id IN (${opts.ids.map(() => "?").join(",")})`);
      p.push(...opts.ids);
    }
    const rows = this.db.all(`SELECT * FROM beliefs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY area, updated_at DESC`, p);
    const ev = this.evidenceFor(rows.map((r) => String(r.id)));
    return rows.map((r) => this.row(r, ev.get(String(r.id)) ?? []));
  }

  get(id: string): Belief | null {
    return this.list({ ids: [id] })[0] ?? null;
  }

  add(b: {
    area: string;
    statement: string;
    provenance: Provenance;
    confidence: number;
    subject_item_id?: string | null;
    evidence_ids?: string[];
    confirmed?: boolean;
  }): Belief {
    const now = this.clock.now().toISOString();
    const id = newId("blf");
    // Inferred beliefs are proposals until Shreyas confirms them.
    const status = b.provenance === "inferred" && !b.confirmed ? "proposed" : "active";
    this.db.run(
      "INSERT INTO beliefs (id, area, statement, subject_item_id, provenance, confidence, status, last_confirmed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, b.area, b.statement, b.subject_item_id ?? null, b.provenance, b.confidence, status, b.confirmed || b.provenance === "stated" ? now : null, now, now],
    );
    for (const e of b.evidence_ids ?? []) this.linkEvidence(id, e);
    return this.get(id)!;
  }

  linkEvidence(beliefId: string, evidenceId: string, note?: string): void {
    this.db.run("INSERT OR IGNORE INTO belief_evidence (belief_id, evidence_id, note) VALUES (?, ?, ?)", [beliefId, evidenceId, note ?? null]);
  }

  confirm(id: string): Belief {
    const now = this.clock.now().toISOString();
    this.db.run("UPDATE beliefs SET status = 'active', last_confirmed_at = ?, confidence = MAX(confidence, 0.9), updated_at = ? WHERE id = ?", [now, now, id]);
    return this.get(id)!;
  }

  edit(id: string, patch: { statement?: string; confidence?: number; area?: string; status?: Belief["status"] }): Belief {
    const b = this.get(id);
    if (!b) throw new Error(`No belief ${id}`);
    const now = this.clock.now().toISOString();
    // A belief edited by hand is now something Shreyas stated.
    const provenance = patch.statement && patch.statement !== b.statement ? "stated" : b.provenance;
    this.db.run(
      "UPDATE beliefs SET statement = ?, confidence = ?, area = ?, status = ?, provenance = ?, last_confirmed_at = ?, updated_at = ? WHERE id = ?",
      [patch.statement ?? b.statement, patch.confidence ?? b.confidence, patch.area ?? b.area, patch.status ?? b.status, provenance, now, now, id],
    );
    return this.get(id)!;
  }

  remove(id: string): void {
    this.db.run("DELETE FROM belief_evidence WHERE belief_id = ?", [id]);
    this.db.run("DELETE FROM beliefs WHERE id = ?", [id]);
  }

  /** Beliefs that are weak or stale: candidates for an active-sensing question. */
  unknowns(limit = 8): Belief[] {
    return this.list({ status: ["active", "proposed"] })
      .filter((b) => b.effective_confidence < 0.55 || b.status === "proposed")
      .sort((a, b) => a.effective_confidence - b.effective_confidence)
      .slice(0, limit);
  }
}
