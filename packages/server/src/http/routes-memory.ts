import type { FastifyInstance } from "fastify";
import type { Services } from "../core/services";

/** Raw-log status and the manual backfill trigger, for the back room. */
export function registerMemoryRoutes(app: FastifyInstance, svc: Services): void {
  app.get("/api/memory/status", async () => ({
    entries: svc.memory.count(),
    by_kind: svc.memory.countByKind(),
    backfill: svc.backfill.progress(),
    episodes: svc.memoryProcessor.episodes(),
    facts: svc.memoryProcessor.facts(),
    pending: svc.memoryProcessor.pending(),
  }));
  app.post("/api/memory/backfill", async () => {
    const backfill = svc.backfill.runAll();
    return { ok: true, backfill };
  });
  app.post("/api/memory/process", async () => {
    const outcome = await svc.memoryProcessor.run({ maxBatches: 50 });
    return { ok: true, outcome };
  });
}
