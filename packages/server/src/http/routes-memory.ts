import type { FastifyInstance } from "fastify";
import type { Services } from "../core/services";

/** Raw-log status and the manual backfill trigger, for the back room. */
export function registerMemoryRoutes(app: FastifyInstance, svc: Services): void {
  app.get("/api/memory/status", async () => ({
    entries: svc.memory.count(),
    by_kind: svc.memory.countByKind(),
    backfill: svc.backfill.progress(),
  }));
  app.post("/api/memory/backfill", async () => {
    const backfill = svc.backfill.runAll();
    return { ok: true, backfill };
  });
}
