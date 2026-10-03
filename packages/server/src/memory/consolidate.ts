import { z } from "zod";
import { BELIEF_AREAS } from "@ava/shared";
import type { Services } from "../core/services";

const ReflectSchema = z.object({
  reflections: z
    .array(
      z.object({
        statement: z.string().max(400),
        area: z.string().max(40),
        entry_ids: z.array(z.string().max(60)).max(10).default([]),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(3),
});

export interface ConsolidationReport {
  gists: { revised: number; removed: number };
  core: "rebuilt" | "skipped";
  duplicates: number;
  importance_updated: number;
  reflections: number;
  calls: number;
  stopped: string | null;
}

/**
 * The nightly consolidation wake: the only place derived layers get revised.
 * Everything here works from the raw log up — stale gists are regenerated
 * from raw entries, near-duplicate facts are linked (never deleted), stale
 * importance is recomputed, and reflections enter the inferred-belief flow
 * as proposals citing at least three raw entries. Bounded by a call budget;
 * results are recorded for the developer panel.
 */
export class Consolidation {
  private running = false;

  constructor(private svc: Services) {}

  private budgetLeft = 0;
  private spend(): boolean {
    if (this.budgetLeft <= 0) return false;
    this.budgetLeft -= 1;
    return true;
  }

  async run(wakeId?: string): Promise<string> {
    if (this.running) return "already running";
    this.running = true;
    const { log, settings } = this.svc;
    const cfg = settings.get().memory.consolidation;
    const report: ConsolidationReport = { gists: { revised: 0, removed: 0 }, core: "skipped", duplicates: 0, importance_updated: 0, reflections: 0, calls: 0, stopped: null };
    this.budgetLeft = cfg.max_calls;
    const spent0 = this.budgetLeft;
    try {
      if (!this.svc.models.available) {
        report.stopped = "no model key";
        log.warn("memory.consolidate", "Consolidation ran without a model key: only deterministic steps", undefined, wakeId);
      }
      await this.regenGists(report);
      await this.refreshCore(report);
      report.duplicates = this.linkDuplicates();
      report.importance_updated = this.recomputeImportance();
      report.reflections = await this.proposeReflections(report);
      report.calls = spent0 - this.budgetLeft;
      if (report.calls >= cfg.max_calls) report.stopped = report.stopped ?? "call budget reached";
      const summary = `gists ${report.gists.revised} revised / ${report.gists.removed} removed, core ${report.core}, ${report.duplicates} duplicates linked, ${report.importance_updated} importance updates, ${report.reflections} reflections, ${report.calls} model calls${report.stopped ? ` (${report.stopped})` : ""}`;
      this.svc.memory.setState("consolidation.last", { at: this.svc.clock.now().toISOString(), summary, report });
      log.info("memory.consolidate", `Consolidation finished: ${summary}`, report as unknown as Record<string, unknown>, wakeId);
      return summary;
    } finally {
      this.running = false;
    }
  }

  /** Regenerate gists for episodes that gained entries or lost raw content. Deletes episodes whose raw is entirely gone. */
  private async regenGists(report: ConsolidationReport): Promise<void> {
    const rows = this.svc.db.all<{ id: string }>("SELECT id FROM episodes WHERE stale = 1 OR gist_enc IS NULL ORDER BY start_at LIMIT 20");
    for (const r of rows) {
      if (!this.spend()) break;
      try {
        const out = await this.svc.memoryProcessor.regenerateGist(r.id);
        if (out === "revised") report.gists.revised++;
        else if (out === "removed") report.gists.removed++;
      } catch (e) {
        this.svc.log.warn("memory.gist", `Gist regeneration failed: ${(e as Error).message}`);
      }
    }
  }

  /** Rebuild the core from L2 + recent gists when something new landed since the last version. */
  private async refreshCore(report: ConsolidationReport): Promise<void> {
    const last = this.svc.core.latest();
    if (last) {
      const fresh = this.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM entries WHERE recorded_at >= ? AND deleted_at IS NULL", [last.created_at])?.n ?? 0;
      if (!fresh) return;
    }
    if (!this.spend()) return;
    const text = await this.svc.core.rebuild();
    report.core = text ? "rebuilt" : "skipped";
  }

  /** Link near-identical current facts to their canonical row (oldest of the group). Never deletes. */
  private linkDuplicates(): number {
    const model = this.svc.embeddings.modelId();
    if (!model) return 0;
    const { db } = this.svc;
    const vecs: { id: string; v: Float32Array; at: string }[] = [];
    for (const r of db.all<{ ref_id: string }>("SELECT ref_id FROM memory_embeddings WHERE ref_kind = 'fact' AND model = ?", [model])) {
      const f = db.get<{ id: string; recorded_at: string }>("SELECT id, recorded_at FROM facts WHERE id = ? AND status = 'current' AND canonical_id IS NULL", [r.ref_id]);
      if (!f) continue;
      const v = this.svc.embeddings.decode("fact", f.id);
      if (v) vecs.push({ id: f.id, v, at: f.recorded_at });
      if (vecs.length >= 400) break;
    }
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
      return root;
    };
    for (let i = 0; i < vecs.length; i++) {
      for (let j = i + 1; j < vecs.length; j++) {
        let dot = 0;
        for (let k = 0; k < vecs[i].v.length; k++) dot += vecs[i].v[k] * vecs[j].v[k];
        if (dot < 0.92) continue;
        const a = find(vecs[i].id);
        const b = find(vecs[j].id);
        if (a !== b) parent.set(a, b);
      }
    }
    const groups = new Map<string, string[]>();
    for (const x of vecs) {
      const root = find(x.id);
      groups.set(root, [...(groups.get(root) ?? []), x.id]);
    }
    let linked = 0;
    for (const ids of groups.values()) {
      if (ids.length < 2) continue;
      const canonical = ids.map((id) => vecs.find((v) => v.id === id)!).sort((a, b) => a.at.localeCompare(b.at))[0].id;
      for (const id of ids) {
        if (id === canonical) continue;
        const changed = db.run("UPDATE facts SET canonical_id = ? WHERE id = ? AND canonical_id IS NULL", [canonical, id]).changes;
        linked += changed;
      }
    }
    if (linked) this.svc.log.info("memory.dedupe", `Linked ${linked} near-duplicate ${linked === 1 ? "fact" : "facts"} to their canonical rows`);
    return linked;
  }

  /** Recompute importance for current facts: grounding, provenance, and staleness, deterministically. */
  private recomputeImportance(): number {
    const { db } = this.svc;
    const rows = db.all<{ id: string; importance: number; provenance: string; refs: number; last_ref: string | null }>(
      `SELECT f.id, f.importance, f.provenance,
        (SELECT COUNT(*) FROM fact_entries fe JOIN entries e ON e.id = fe.entry_id WHERE fe.fact_id = f.id AND e.deleted_at IS NULL) AS refs,
        (SELECT MAX(e.recorded_at) FROM fact_entries fe JOIN entries e ON e.id = fe.entry_id WHERE fe.fact_id = f.id AND e.deleted_at IS NULL) AS last_ref
       FROM facts f WHERE f.status = 'current' LIMIT 1000`,
    );
    const now = this.svc.clock.now().getTime();
    let n = 0;
    for (const f of rows) {
      const base = f.provenance === "stated" ? 0.6 : f.provenance === "inferred" ? 0.45 : 0.4;
      let imp = base + Math.min(0.25, 0.1 * Math.max(0, Number(f.refs) - 1));
      if (f.last_ref && now - Date.parse(f.last_ref) > 120 * 86_400_000) imp -= 0.15;
      imp = Math.max(0.15, Math.min(1, imp));
      if (Math.abs(imp - Number(f.importance)) >= 0.05) {
        db.run("UPDATE facts SET importance = ? WHERE id = ?", [imp, f.id]);
        this.svc.memorySearch.indexFact(f.id);
        n++;
      }
    }
    if (n) this.svc.log.info("memory.importance", `Recomputed importance for ${n} ${n === 1 ? "fact" : "facts"}`);
    return n;
  }

  /** Look for durable patterns; each must cite at least three raw entries and enters the belief flow as a proposal. */
  private async proposeReflections(report: ConsolidationReport): Promise<number> {
    const { db, cipher, models, cfg, log, clock } = this.svc;
    if (!models.available || !this.spend()) return 0;
    const since = new Date(clock.now().getTime() - 21 * 86_400_000).toISOString();
    const rows = db.all<{ id: string; text_enc: string }>("SELECT id, text_enc FROM entries WHERE deleted_at IS NULL AND role = 'user' AND recorded_at >= ? ORDER BY recorded_at DESC LIMIT 40", [since]);
    if (rows.length < 3) return 0;
    const texts = new Map(rows.map((r) => [r.id, cipher.decOpt(r.text_enc) ?? ""]));
    const material = rows.map((r) => `[${r.id}] ${(texts.get(r.id) ?? "").slice(0, 240)}`).join("\n");
    try {
      const r = await models.complete({
        purpose: "memory.reflections",
        origin: "system",
        model: cfg.models.fast,
        maxTokens: 700,
        schema: ReflectSchema,
        system:
          `You look for durable patterns in what ${cfg.ownerName} says, to propose as inferred beliefs for him to confirm or reject. A candidate must be supported by at least three separate raw entries (cite their [ids] exactly); cite nothing else. No mind-reading, no negative traits, no flattery, nothing already obvious from single statements. 0-2 proposals; empty is fine. Areas: ${BELIEF_AREAS.join(", ")}. Return JSON {reflections: [{statement, area, entry_ids, confidence}]}.`,
        messages: [{ role: "user", content: material }],
      });
      let n = 0;
      for (const refl of r.parsed?.reflections ?? []) {
        const ids = refl.entry_ids.filter((id) => !!db.get("SELECT id FROM entries WHERE id = ? AND deleted_at IS NULL", [id]));
        if (ids.length < 3) continue; // the three-raw-entry rule, enforced here, not trusted to the model
        if (db.get("SELECT id FROM beliefs WHERE statement = ?", [refl.statement])) continue;
        const evidenceIds = ids.map((id) => {
          const existing = db.get<{ id: string }>("SELECT id FROM evidence WHERE source_ref = ? LIMIT 1", [id]);
          return existing?.id ?? this.svc.evidence.add({ kind: "transcript", source: "memory", content: { entry_id: id }, summary: (texts.get(id) ?? "").slice(0, 280), source_ref: id });
        });
        this.svc.beliefs.add({ area: refl.area, statement: refl.statement, provenance: "inferred", confidence: refl.confidence, confirmed: false, evidence_ids: evidenceIds });
        n++;
        log.info("memory.reflection", `A pattern from ${ids.length} raw entries entered the belief flow as a proposal: "${refl.statement.slice(0, 140)}"`);
      }
      void report;
      return n;
    } catch (e) {
      log.warn("memory.reflections", `Reflection pass skipped: ${(e as Error).message}`);
      return 0;
    }
  }
}
