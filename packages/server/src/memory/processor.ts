import { z } from "zod";
import type { Services } from "../core/services";
import { newId } from "../db/db";

/**
 * The first derived layer, built from raw entries and never from other
 * summaries. Episodes are short coherent units (a stretch of one
 * conversation, one brain dump, one imported conversation) with a 1-3
 * sentence gist that routes retrieval back to the raw text. Facts are atomic
 * statements keyed to the raw entries they came from. Both are add-only:
 * rerunning leaves existing episodes and facts untouched, and regeneration
 * (consolidation) always works from the raw entries themselves.
 */

const GistSchema = z.object({
  gist: z.string().min(1).max(800),
  keywords: z.array(z.string().max(60)).max(12).default([]),
  entities: z.array(z.string().max(80)).max(12).default([]),
  importance: z.number().min(0).max(1).default(0.5),
});
const FactsSchema = z.object({
  facts: z
    .array(
      z.object({
        statement: z.string().min(3).max(400),
        refers_at: z.string().max(40).nullable().default(null),
        provenance: z.enum(["stated", "observed", "inferred"]).default("stated"),
        confidence: z.number().min(0).max(1).default(0.85),
        importance: z.number().min(0).max(1).default(0.5),
        keywords: z.array(z.string().max(60)).max(8).default([]),
        entities: z.array(z.string().max(80)).max(8).default([]),
        entry_ids: z.array(z.string()).max(12).default([]),
      }),
    )
    .max(12),
});

/** Entry kinds that feed episodes and facts. */
const TEXT_KINDS = ["turn", "transcript", "import", "sent_mail", "answer"];
const GAP_MINUTES = 45;
const MAX_BATCH_ENTRIES = 12;
const MAX_BATCH_CHARS = 9000;

interface RawRow {
  id: string;
  kind: string;
  source: string;
  role: string | null;
  session_id: string | null;
  occurred_at: string;
  recorded_at: string;
  text_enc: string;
  deleted_at: string | null;
}
interface RawEntry {
  id: string;
  kind: string;
  source: string;
  role: string | null;
  session_id: string | null;
  occurred_at: string;
  recorded_at: string;
  text: string;
}

export interface ProcessOutcome {
  batches: number;
  episodes: number;
  facts: number;
  /** Why the run stopped early, if it did ("no model key", a parse error message). */
  stopped: string | null;
}

export class MemoryProcessor {
  private running = false;
  private queued = false;

  constructor(private svc: Services) {}

  /** Raw entries not yet covered by any episode. */
  pending(): number {
    return (
      this.svc.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM entries e LEFT JOIN episode_entries ee ON ee.entry_id = e.id
         WHERE ee.entry_id IS NULL AND e.deleted_at IS NULL AND e.kind IN (${TEXT_KINDS.map(() => "?").join(",")})`,
        TEXT_KINDS,
      )?.n ?? 0
    );
  }

  episodes(): number {
    return this.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM episodes")?.n ?? 0;
  }

  facts(): number {
    return this.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM facts WHERE status != 'removed'")?.n ?? 0;
  }

  /**
   * Debounced kick after new raw entries land. Runs a few batches per event
   * loop turn, off the request path. Disabled on the test profile so tests
   * drive the processor explicitly.
   */
  notify(): void {
    if (this.svc.cfg.profile === "test" || this.queued || this.running) return;
    this.queued = true;
    setImmediate(() => {
      this.queued = false;
      this.run({ maxBatches: 4 }).catch((e) => this.svc.log.warn("memory.process", `Processing paused: ${(e as Error).message}`));
    });
  }

  /** Process uncovered entries into episodes + facts. Idempotent and resumable. */
  async run(opts: { maxBatches?: number } = {}): Promise<ProcessOutcome> {
    const out: ProcessOutcome = { batches: 0, episodes: 0, facts: 0, stopped: null };
    if (this.running) {
      out.stopped = "already running";
      return out;
    }
    this.running = true;
    try {
      const max = opts.maxBatches ?? 12;
      while (out.batches < max) {
        const batch = this.nextBatch();
        if (!batch.length) break;
        if (!this.svc.models.available) {
          out.stopped = "no model key";
          break;
        }
        const made = await this.processBatch(batch);
        out.batches += 1;
        out.episodes += made.episodes;
        out.facts += made.facts;
      }
    } catch (e) {
      out.stopped = (e as Error).message;
      this.svc.log.warn("memory.process", `Processing paused: ${(e as Error).message}; the raw entries stay and it retries later`);
    } finally {
      this.running = false;
    }
    return out;
  }

  // ------------------------------------------------------------- batching

  private firstUncovered(): RawEntry | null {
    const r = this.svc.db.get<RawRow>(
      `SELECT e.* FROM entries e LEFT JOIN episode_entries ee ON ee.entry_id = e.id
       WHERE ee.entry_id IS NULL AND e.deleted_at IS NULL AND e.kind IN (${TEXT_KINDS.map(() => "?").join(",")})
       ORDER BY e.recorded_at, e.rowid LIMIT 1`,
      TEXT_KINDS,
    );
    return r ? this.raw(r) : null;
  }

  /** One coherent unit: consecutive entries of a session (or one standalone record) within a time gap. */
  private nextBatch(): RawEntry[] {
    const first = this.firstUncovered();
    if (!first) return [];
    const until = new Date(new Date(first.recorded_at).getTime() + GAP_MINUTES * 60_000).toISOString();
    const rows = first.session_id
      ? this.svc.db.all<RawRow>(
          `SELECT e.* FROM entries e LEFT JOIN episode_entries ee ON ee.entry_id = e.id
           WHERE ee.entry_id IS NULL AND e.deleted_at IS NULL AND e.kind IN (${TEXT_KINDS.map(() => "?").join(",")})
             AND e.session_id = ? AND e.recorded_at >= ? AND e.recorded_at <= ?
           ORDER BY e.recorded_at, e.rowid LIMIT ?`,
          [...TEXT_KINDS, first.session_id, first.recorded_at, until, MAX_BATCH_ENTRIES],
        )
      : [this.svc.db.get<RawRow>("SELECT * FROM entries WHERE id = ?", [first.id])!];
    const batch: RawEntry[] = [];
    let size = 0;
    for (const r of rows) {
      const e = this.raw(r);
      if (size + e.text.length > MAX_BATCH_CHARS && batch.length) break;
      batch.push(e);
      size += e.text.length;
    }
    return batch;
  }

  private raw(r: RawRow): RawEntry {
    return {
      id: r.id,
      kind: r.kind,
      source: r.source,
      role: r.role ?? null,
      session_id: r.session_id ?? null,
      occurred_at: r.occurred_at,
      recorded_at: r.recorded_at,
      text: this.svc.cipher.decOpt(r.text_enc) ?? "",
    };
  }

  // ------------------------------------------------------------ one batch

  /** Model calls first; only persist once both succeed, so a failure retries the whole batch later. */
  private async processBatch(batch: RawEntry[]): Promise<{ episodes: number; facts: number }> {
    const gist = await this.gistFor(batch);
    const facts = await this.factsFor(batch);
    const episodeId = this.saveEpisode(batch, gist);
    const factIds = this.saveFacts(batch, facts, episodeId);
    this.svc.memorySearch.indexEpisode(episodeId);
    // L2's guard: a cheap judge supersedes genuine contradictions (add-only otherwise).
    try {
      if (factIds.length) await this.svc.contradict.review(factIds);
    } catch (e) {
      this.svc.log.warn("memory.contradict", `Contradiction review skipped: ${(e as Error).message}`);
    }
    // Vectors for the semantic half of hybrid search; failures never block the raw pipeline.
    try {
      await this.svc.embeddings.ensure("entry", batch.map((e) => e.id));
      await this.svc.embeddings.ensure("episode", [episodeId]);
      await this.svc.embeddings.ensure("fact", factIds);
    } catch (e) {
      this.svc.log.warn("memory.embed", `Embeddings skipped for this batch: ${(e as Error).message}`);
    }
    return { episodes: 1, facts: factIds.length };
  }

  private async gistFor(batch: RawEntry[]): Promise<z.infer<typeof GistSchema>> {
    const who = (e: RawEntry) => (e.role === "ava" ? "Ava" : e.kind === "sent_mail" ? "His sent mail" : e.kind === "import" ? "His older chat" : "He");
    const text = batch.map((e) => `${who(e)}: ${e.text}`).join("\n\n").slice(0, 6000);
    const r = await this.svc.models.complete({
      purpose: "memory.gist",
      origin: "system",
      model: this.svc.cfg.models.fast,
      maxTokens: 400,
      schema: GistSchema,
      system:
        "You write the gist of one slice of Shreyas's raw log: 1-3 plain sentences about what he was doing, saying or thinking in it. Neutral, specific, no praise. Also give up to 12 keywords (for search routing, lowercase) and up to 12 entities (people, courses, projects, places by name). Importance 0-1 for how much this slice matters to remember.",
      messages: [{ role: "user", content: text }],
    });
    if (!r?.parsed) throw new Error(r?.parseError ?? "The gist call returned nothing");
    return r.parsed;
  }

  private async factsFor(batch: RawEntry[]): Promise<z.infer<typeof FactsSchema>["facts"]> {
    const mine = batch.filter((e) => e.role !== "ava");
    if (!mine.length) return [];
    const text = mine.map((e) => `[${e.id}] ${e.text}`).join("\n\n").slice(0, 9000);
    const r = await this.svc.models.complete({
      purpose: "memory.facts",
      origin: "system",
      model: this.svc.cfg.models.fast,
      maxTokens: 800,
      schema: FactsSchema,
      system:
        "Extract atomic facts FROM SHREYAS'S OWN WORDS ONLY (extract nothing Ava said). One fact per line-item: a single thing now known about him, his life, his people, his work or his preferences, in plain present or past tense. refers_at: if the fact is about when something happens or happened, an ISO date or short phrase, else null. Put the id of every source line the fact came from in entry_ids (use exactly the [ids] given). Only what is actually said; never infer beyond it. Empty list if nothing durable.",
      messages: [{ role: "user", content: text }],
    });
    if (!r?.parsed) throw new Error(r?.parseError ?? "The facts call returned nothing");
    const valid = new Set(batch.map((e) => e.id));
    return r.parsed.facts.map((f) => ({ ...f, entry_ids: f.entry_ids.filter((id) => valid.has(id)) }));
  }

  /**
   * Add-only: joins a recent same-session episode when the batch continues it
   * (marking it stale so consolidation regenerates its gist from raw), else
   * creates a new episode. Never edits an existing gist here.
   */
  private saveEpisode(batch: RawEntry[], gist: z.infer<typeof GistSchema>): string {
    const { db, cipher, clock, log } = this.svc;
    const now = clock.now().toISOString();
    const first = batch[0];
    const last = batch[batch.length - 1];
    const joinable = first.session_id
      ? db.get<{ id: string; end_at: string; max_pos: number }>(
          `SELECT ep.id, ep.end_at, (SELECT MAX(position) FROM episode_entries x WHERE x.episode_id = ep.id) AS max_pos
           FROM episodes ep WHERE ep.session_id = ? ORDER BY ep.end_at DESC LIMIT 1`,
          [first.session_id],
        )
      : null;
    const gapOk = joinable && new Date(first.recorded_at).getTime() - new Date(joinable.end_at).getTime() <= GAP_MINUTES * 60_000;
    let episodeId: string;
    if (joinable && gapOk) {
      episodeId = joinable.id;
      db.run("UPDATE episodes SET end_at = ?, stale = 1, revised_at = ? WHERE id = ?", [last.recorded_at, now, episodeId]);
    } else {
      episodeId = newId("epi");
      db.run("INSERT INTO episodes (id, source, session_id, start_at, end_at, recorded_at, gist_enc, keywords_enc, entities_enc, importance, version, revised_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)", [
        episodeId,
        first.source,
        first.session_id,
        first.occurred_at,
        last.occurred_at,
        now,
        cipher.encrypt(gist.gist),
        cipher.encJson(gist.keywords),
        cipher.encJson(gist.entities),
        gist.importance,
        now,
      ]);
    }
    let pos = joinable && gapOk ? Number(Number(db.get<{ m: number }>("SELECT MAX(position) AS m FROM episode_entries WHERE episode_id = ?", [episodeId])?.m ?? 0) + 1) : 0;
    for (const e of batch) {
      db.run("INSERT OR IGNORE INTO episode_entries (episode_id, entry_id, position) VALUES (?, ?, ?)", [episodeId, e.id, pos++]);
    }
    log.info("memory.episode", `Gisted ${batch.length} ${batch.length === 1 ? "entry" : "entries"}${first.session_id ? " from a conversation" : ` from ${first.kind}`}: "${gist.gist.slice(0, 120)}"`, { episode_id: episodeId });
    return episodeId;
  }

  /** Add-only: new fact rows with their source links. Nothing existing is touched. */
  private saveFacts(batch: RawEntry[], facts: z.infer<typeof FactsSchema>["facts"], episodeId: string): string[] {
    const { db, cipher, clock, log } = this.svc;
    const now = clock.now().toISOString();
    const ids: string[] = [];
    for (const f of facts) {
      const id = newId("fct");
      const sources = f.entry_ids.length ? f.entry_ids : batch.filter((e) => e.role !== "ava").map((e) => e.id);
      db.run(
        "INSERT INTO facts (id, statement_enc, keywords_enc, entities_enc, refers_at, recorded_at, valid_from, provenance, confidence, importance, source, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?)",
        [id, cipher.encrypt(f.statement), cipher.encJson(f.keywords), cipher.encJson(f.entities), f.refers_at, now, now, f.provenance, f.confidence, f.importance, batch[0].source, now],
      );
      for (const entryId of sources) db.run("INSERT OR IGNORE INTO fact_entries (fact_id, entry_id) VALUES (?, ?)", [id, entryId]);
      this.svc.memorySearch.indexFact(id);
      ids.push(id);
    }
    if (ids.length) log.info("memory.facts", `Extracted ${ids.length} ${ids.length === 1 ? "fact" : "facts"} from ${batch.length} raw ${batch.length === 1 ? "entry" : "entries"}`, { episode_id: episodeId, facts: ids.length });
    return ids;
  }

  /**
   * The derived layers follow forgotten raw entries out: covering episodes are
   * marked stale (their gists get regenerated from the remaining raw), and a
   * fact that loses its last raw source is removed. Called from the forget
   * watcher; the forget flow previews exactly this closure before deleting.
   */
  syncDerivedAfterForget(entryIds: string[]): void {
    const { db } = this.svc;
    for (const id of entryIds) {
      db.run("UPDATE episodes SET stale = 1 WHERE id IN (SELECT episode_id FROM episode_entries WHERE entry_id = ?)", [id]);
      for (const f of db.all<{ id: string }>("SELECT DISTINCT fact_id AS id FROM fact_entries WHERE entry_id = ?", [id])) {
        const remaining = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM fact_entries fe JOIN entries e ON e.id = fe.entry_id WHERE fe.fact_id = ? AND e.deleted_at IS NULL", [f.id])?.n ?? 0;
        if (remaining === 0) {
          db.run("UPDATE facts SET status = 'removed' WHERE id = ?", [f.id]);
          this.svc.memorySearch.removeRef("fact", f.id);
          this.svc.embeddings.remove("fact", f.id);
        }
      }
    }
  }

  /**
   * Regenerate one episode's gist from its raw entries (forgotten entries
   * excluded). An episode that lost all its raw content is removed with it.
   * Only consolidation calls this.
   */
  async regenerateGist(episodeId: string): Promise<"revised" | "removed" | "skipped"> {
    const { db, cipher, clock, log } = this.svc;
    const entries = this.svc.memory
      .episodeEntries(episodeId)
      .map((id) => this.svc.memory.get(id))
      .filter((e): e is NonNullable<typeof e> => !!e && !e.deleted_at && !!e.text.trim());
    if (!entries.length) {
      db.run("DELETE FROM entry_links WHERE target_kind = 'episode' AND target_id = ?", [episodeId]);
      db.run("DELETE FROM episode_entries WHERE episode_id = ?", [episodeId]);
      db.run("DELETE FROM episodes WHERE id = ?", [episodeId]);
      this.svc.memorySearch.removeRef("episode", episodeId);
      this.svc.embeddings.remove("episode", episodeId);
      log.info("memory.gist", "Removed an episode whose raw entries were all forgotten", { episode_id: episodeId });
      return "removed";
    }
    const gist = await this.gistFor(entries);
    const now = clock.now().toISOString();
    db.run("UPDATE episodes SET gist_enc = ?, keywords_enc = ?, entities_enc = ?, importance = ?, stale = 0, version = version + 1, revised_at = ? WHERE id = ?", [
      cipher.encrypt(gist.gist),
      cipher.encJson(gist.keywords),
      cipher.encJson(gist.entities),
      gist.importance,
      now,
      episodeId,
    ]);
    this.svc.memorySearch.indexEpisode(episodeId);
    this.svc.embeddings.remove("episode", episodeId);
    try {
      await this.svc.embeddings.ensure("episode", [episodeId]);
    } catch (e) {
      log.warn("memory.embed", `Re-embed skipped: ${(e as Error).message}`);
    }
    log.info("memory.gist", `Regenerated an episode's gist from raw (v${Number(db.get<{ version: number }>("SELECT version FROM episodes WHERE id = ?", [episodeId])?.version ?? 0)}): "${gist.gist.slice(0, 120)}"`, { episode_id: episodeId });
    return "revised";
  }
}
