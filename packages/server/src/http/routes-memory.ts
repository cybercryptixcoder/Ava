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
    return { hits: svc.memorySearch.search(q, { kinds: req.body?.kinds, since: req.body?.since, until: req.body?.until, limit: req.body?.limit }) };
  });
  app.post<{ Body: { query?: string; budget_tokens?: number } }>("/api/memory/retrieve", async (req) => {
    const q = String(req.body?.query ?? "").trim();
    if (!q) return { pack: null };
    const pack = await svc.retriever.retrieve(q, { budgetTokens: req.body?.budget_tokens });
    return { pack };
  });
  app.post("/api/memory/reembed", async () => ({ ok: true, count: await svc.embeddings.reembedAll(), embeddings: svc.embeddings.count() }));
}
