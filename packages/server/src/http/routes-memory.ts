import type { FastifyInstance } from "fastify";
import type { Services } from "../core/services";
import type { RefKind } from "../memory/search";

/** Raw-log status, search, retrieval and the manual triggers, for the back room. */
export function registerMemoryRoutes(app: FastifyInstance, svc: Services): void {
  app.get("/api/memory/status", async () => ({
    entries: svc.memory.count(),
    by_kind: svc.memory.countByKind(),
    backfill: svc.backfill.progress(),
    episodes: svc.memoryProcessor.episodes(),
    facts: svc.memoryProcessor.facts(),
    pending: svc.memoryProcessor.pending(),
    embeddings: svc.embeddings.count(),
  }));
  app.post("/api/memory/backfill", async () => {
    const backfill = svc.backfill.runAll();
    return { ok: true, backfill };
  });
  app.post("/api/memory/process", async () => {
    const outcome = await svc.memoryProcessor.run({ maxBatches: 50 });
    return { ok: true, outcome };
  });
  app.post<{ Body: { query?: string; kinds?: RefKind[]; since?: string; until?: string; limit?: number } }>("/api/memory/search", async (req) => {
    const q = String(req.body?.query ?? "").trim();
    if (!q) return { hits: [] };
    const previewOf = (kind: RefKind, id: string): string => {
      if (kind === "entry") return (svc.memory.get(id)?.text ?? "").slice(0, 160);
      if (kind === "episode") return svc.cipher.decOpt(svc.db.get<{ gist_enc: string | null }>("SELECT gist_enc FROM episodes WHERE id = ?", [id])?.gist_enc ?? "") ?? "";
      const r = svc.db.get<{ statement_enc: string }>("SELECT statement_enc FROM facts WHERE id = ?", [id]);
      return r ? (svc.cipher.decOpt(r.statement_enc) ?? "").slice(0, 160) : "";
    };
    return {
      hits: svc.memorySearch.search(q, { kinds: req.body?.kinds, since: req.body?.since, until: req.body?.until, limit: req.body?.limit }).map((h) => ({ ...h, preview: previewOf(h.ref_kind, h.ref_id) })),
    };
  });
  app.post<{ Body: { query?: string; budget_tokens?: number } }>("/api/memory/retrieve", async (req) => {
    const q = String(req.body?.query ?? "").trim();
    if (!q) return { pack: null };
    const pack = await svc.retriever.retrieve(q, { budgetTokens: req.body?.budget_tokens });
    return { pack };
  });
  app.post("/api/memory/reembed", async () => ({ ok: true, count: await svc.embeddings.reembedAll(), embeddings: svc.embeddings.count() }));

  // ------------------------------------------------------- the memory screen

  app.get<{ Querystring: { limit?: string } }>("/api/memory/entries", async (req) => {
    const limit = Math.min(300, Math.max(10, Number(req.query.limit ?? 120)));
    return {
      entries: svc.db
        .all<Record<string, unknown>>("SELECT id, kind, source, role, occurred_at, recorded_at, text_enc, deleted_at, deleted_reason FROM entries ORDER BY recorded_at DESC LIMIT ?", [limit])
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          source: r.source,
          role: r.role ?? null,
          at: r.occurred_at,
          recorded_at: r.recorded_at,
          text: (svc.cipher.decOpt(r.text_enc as string) ?? "").slice(0, 220),
          deleted: !!r.deleted_at,
          deleted_reason: r.deleted_reason ?? null,
        })),
    };
  });

  app.get<{ Params: { id: string } }>("/api/memory/entry/:id", async (req) => {
    const e = svc.memory.get(req.params.id);
    if (!e) return { entry: null };
    const row = svc.db.get<{ deleted_reason: string | null }>("SELECT deleted_reason FROM entries WHERE id = ?", [e.id]);
    return {
      entry: {
        id: e.id,
        kind: e.kind,
        source: e.source,
        role: e.role,
        at: e.occurred_at,
        recorded_at: e.recorded_at,
        text: e.text,
        deleted: !!e.deleted_at,
        deleted_reason: row?.deleted_reason ?? null,
        meta: e.meta,
        links: svc.memory.linksOf(e.id).map((l) => ({ rel: l.rel, target_kind: l.target_kind, target_id: l.target_id })),
        episodes: svc.db.all<{ episode_id: string }>("SELECT episode_id FROM episode_entries WHERE entry_id = ?", [e.id]).map((r) => r.episode_id),
      },
    };
  });

  app.get("/api/memory/episodes", async () => ({
    episodes: svc.db.all<Record<string, unknown>>("SELECT id, source, session_id, start_at, end_at, gist_enc, importance, stale, version FROM episodes ORDER BY start_at DESC LIMIT 80").map((r) => ({
      id: r.id,
      at: r.start_at,
      end: r.end_at,
      source: r.source,
      session_id: r.session_id ?? null,
      gist: svc.cipher.decOpt(r.gist_enc as string) ?? "",
      importance: Number(r.importance),
      stale: !!r.stale,
      version: Number(r.version),
      entries: Number(svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM episode_entries WHERE episode_id = ?", [String(r.id)])?.n ?? 0),
    })),
  }));

  app.get<{ Params: { id: string } }>("/api/memory/episode/:id", async (req) => {
    const r = svc.db.get<Record<string, unknown>>("SELECT id, source, session_id, start_at, end_at, gist_enc, importance, stale, version FROM episodes WHERE id = ?", [req.params.id]);
    if (!r) return { episode: null };
    const entries = svc.memory
      .episodeEntries(String(r.id))
      .map((id) => svc.memory.get(id))
      .filter((x): x is NonNullable<typeof x> => !!x)
      .map((e) => ({ id: e.id, at: e.occurred_at, role: e.role, kind: e.kind, deleted: !!e.deleted_at, preview: e.text.slice(0, 200) }));
    return {
      episode: {
        id: r.id,
        at: r.start_at,
        end: r.end_at,
        source: r.source,
        session_id: r.session_id ?? null,
        gist: svc.cipher.decOpt(r.gist_enc as string) ?? "",
        importance: Number(r.importance),
        stale: !!r.stale,
        version: Number(r.version),
        entries,
      },
    };
  });

  app.get<{ Querystring: { status?: string } }>("/api/memory/facts", async (req) => {
    const status = req.query.status === "superseded" || req.query.status === "all" ? req.query.status : "current";
    const where = status === "all" ? "WHERE status != 'removed'" : status === "superseded" ? "WHERE status = 'superseded'" : "WHERE status = 'current' AND valid_to IS NULL";
    return {
      facts: svc.db
        .all<Record<string, unknown>>(
          `SELECT id, statement_enc, status, provenance, valid_from, valid_to, superseded_by, canonical_id, importance, recorded_at, (SELECT COUNT(*) FROM fact_entries fe WHERE fe.fact_id = facts.id) AS sources FROM facts ${where} ORDER BY recorded_at DESC LIMIT 200`,
        )
        .map((r) => ({
          id: r.id,
          statement: svc.cipher.decOpt(r.statement_enc as string) ?? "",
          status: r.status,
          provenance: r.provenance,
          valid_from: r.valid_from ?? null,
          valid_to: r.valid_to ?? null,
          superseded_by: r.superseded_by ?? null,
          canonical_id: r.canonical_id ?? null,
          importance: Number(r.importance),
          recorded_at: r.recorded_at,
          sources: Number(r.sources ?? 0),
        })),
    };
  });

  app.get<{ Params: { id: string } }>("/api/memory/fact/:id", async (req) => {
    const r = svc.db.get<Record<string, unknown>>("SELECT * FROM facts WHERE id = ?", [req.params.id]);
    if (!r) return { fact: null };
    // The full validity chain: walk back to the oldest ancestor, then forward through supersessions.
    let root = String(r.id);
    for (let i = 0; i < 20; i++) {
      const p = svc.db.get<{ id: string }>("SELECT id FROM facts WHERE superseded_by = ?", [root]);
      if (!p) break;
      root = p.id;
    }
    const chain: { id: string; statement: string; status: string; valid_from: string | null; valid_to: string | null }[] = [];
    let cur: string | null = root;
    for (let i = 0; i < 20; i++) {
      if (cur === null) break;
      const row: Record<string, unknown> | undefined = svc.db.get("SELECT id, statement_enc, status, valid_from, valid_to, superseded_by FROM facts WHERE id = ?", [cur]);
      if (!row) break;
      chain.push({ id: String(row.id), statement: svc.cipher.decOpt(row.statement_enc as string) ?? "", status: String(row.status), valid_from: (row.valid_from as string) ?? null, valid_to: (row.valid_to as string) ?? null });
      cur = (row.superseded_by as string | null) ?? null;
    }
    const sources = svc.db
      .all<{ entry_id: string }>("SELECT entry_id FROM fact_entries WHERE fact_id = ?", [String(r.id)])
      .map((x) => svc.memory.get(x.entry_id))
      .filter((e): e is NonNullable<typeof e> => !!e)
      .map((e) => ({ id: e.id, at: e.occurred_at, preview: e.text.slice(0, 160), deleted: !!e.deleted_at }));
    return {
      fact: {
        id: r.id,
        statement: svc.cipher.decOpt(r.statement_enc as string) ?? "",
        status: r.status,
        provenance: r.provenance,
        valid_from: r.valid_from ?? null,
        valid_to: r.valid_to ?? null,
        superseded_by: r.superseded_by ?? null,
        canonical_id: r.canonical_id ?? null,
        importance: Number(r.importance),
        recorded_at: r.recorded_at,
        sources: sources.length,
        chain,
        source_entries: sources,
      },
    };
  });

  app.get("/api/memory/core", async () => ({ latest: svc.core.latest(), versions: svc.core.versions(30) }));

  app.get("/api/memory/consolidate", async () => ({
    last: svc.memory.getState("consolidation.last"),
    recent: svc.db.all<{ at: string; kind: string; summary: string }>("SELECT at, kind, summary FROM log WHERE kind LIKE 'memory.%' ORDER BY rowid DESC LIMIT 40"),
  }));

  app.post<{ Body: { entry_ids?: string[]; episode_id?: string; fact_id?: string; query?: string } }>("/api/memory/forget/preview", async (req) => {
    const ids = svc.forgetFlow.resolve(req.body ?? {});
    return { entry_ids: ids, closure: svc.forgetFlow.preview(ids) };
  });

  app.post<{ Body: { entry_ids?: string[]; reason?: string } }>("/api/memory/forget/apply", async (req) => {
    const ids = (req.body?.entry_ids ?? []).slice(0, 200);
    if (!ids.length) return { ok: false, summary: "Nothing selected" };
    const r = await svc.forgetFlow.apply(ids, String(req.body?.reason ?? "forgotten from the memory screen"));
    return { ok: true, summary: r.summary, closure: r.closure };
  });
}
