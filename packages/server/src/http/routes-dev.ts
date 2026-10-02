import type { FastifyInstance } from "fastify";
import type { Services } from "../core/services";
import { configReport } from "../config/config";
import { SimClock } from "../core/clock";
import { runRetention } from "../core/retention";
import { PersonalityRunner } from "../personality/runner";
import type { WakeKind } from "../scheduler/scheduler";
import { latencyView, usageView } from "./views";

/** Developer panel: config report, model usage, latency, time simulation, personality runs. */
export function registerDevRoutes(app: FastifyInstance, svc: Services): void {
  const personality = new PersonalityRunner(svc);

  app.get("/api/config/report", async () => configReport(svc.cfg));
  app.get("/api/dev/usage", async () => usageView(svc));
  app.get("/api/dev/latency", async () => latencyView(svc));
  app.get("/api/dev/clock", async () => ({ now: svc.clock.now().toISOString(), simulated: svc.clock.simulated, profile: svc.cfg.profile, tz: svc.settings.tz() }));

  /** Time simulation: fast-forward the test profile's clock, running wakes as they come due. */
  app.post<{ Body: { hours?: number; to?: string } }>("/api/dev/clock/advance", async (req, reply) => {
    if (!(svc.clock instanceof SimClock) || svc.cfg.profile !== "test") return reply.code(403).send({ error: "Time simulation only runs on the test profile" });
    const target = req.body.to ? new Date(req.body.to) : new Date(svc.clock.now().getTime() + (Number(req.body.hours) || 1) * 3_600_000);
    const ran: { id: string; kind: string; due_at: string }[] = [];
    await svc.scheduler.advanceTo(target, (w) => ran.push({ id: w.id, kind: w.kind, due_at: w.due_at }));
    svc.scheduler.ensureSystemWakes();
    svc.bus.emit({ type: "state.changed", what: ["items", "wakes", "messages", "rules", "brief"] });
    return { now: svc.clock.now().toISOString(), ran };
  });

  app.post<{ Body: { to: string } }>("/api/dev/clock/set", async (req, reply) => {
    if (!(svc.clock instanceof SimClock) || svc.cfg.profile !== "test") return reply.code(403).send({ error: "Time simulation only runs on the test profile" });
    const to = new Date(req.body.to);
    if (to < svc.clock.now()) {
      // Jumping backwards: drop pending system anchors and re-arm them from the new time.
      svc.db.run("UPDATE wakes SET status = 'cancelled', outcome = 'clock moved back' WHERE status = 'pending' AND kind IN ('heartbeat','brief','evening','weekly','lookahead')");
    }
    svc.clock.set(to);
    svc.scheduler.ensureSystemWakes();
    svc.bus.emit({ type: "clock.changed", now: to.toISOString() });
    return { now: to.toISOString() };
  });

  /** Run a wake now (any profile). Useful to see a heartbeat or a brief without waiting. */
  app.post<{ Body: { kind: WakeKind } }>("/api/dev/wake", async (req) => {
    const kind = req.body.kind;
    if (!["heartbeat", "brief", "evening", "weekly"].includes(kind)) throw new Error("Only heartbeat, brief, evening and weekly can be run by hand");
    if (kind === "brief") svc.db.run("DELETE FROM briefs WHERE date = ?", [svc.counters.today()]);
    const w = svc.scheduler.system({ kind, at: svc.clock.now(), reason: `Run by hand: ${kind}`, owner: "user", dedupe_key: `manual:${kind}:${svc.clock.now().toISOString()}` });
    if (svc.clock.simulated) await svc.scheduler.advanceTo(svc.clock.now());
    else await svc.scheduler.tick();
    return svc.scheduler.get(w.id);
  });

  app.post("/api/dev/retention", async () => runRetention(svc));

  app.get("/api/personality/status", async () => personality.status());
  app.get("/api/personality/runs", async () => personality.runs(10));
  app.post<{ Body: { label?: string; audio?: boolean } }>("/api/personality/run", async (req) => personality.run({ label: req.body?.label, audio: req.body?.audio }));
}
