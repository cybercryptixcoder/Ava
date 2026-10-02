import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Services } from "../core/services";

const RespondBody = z.object({ response: z.enum(["yes", "not_now", "already_done", "stop"]), option: z.string().nullable().optional() });

/** The front room: the card stack, its layers and responses, filing undo, and threads. */
export function registerStackRoutes(app: FastifyInstance, svc: Services): void {
  const { cards, filing, threads, clock, settings } = svc;

  app.get("/api/stack", async () => cards.stack());

  app.get<{ Params: { id: string; n: string } }>("/api/cards/:id/layer/:n", async (req, reply) => {
    if (req.params.n === "2") return cards.layer2(req.params.id);
    if (req.params.n === "3") return cards.layer3(req.params.id);
    return reply.code(404).send({ error: "Cards have layers 2 and 3" });
  });

  app.post<{ Params: { id: string } }>("/api/cards/:id/respond", async (req) => {
    const body = RespondBody.parse(req.body);
    const result = await cards.respond(req.params.id, body.response, body.option ?? null);
    return { result, stack: cards.stack() };
  });

  app.post<{ Params: { id: string } }>("/api/filings/:id/undo", async (req) => ({ proposal: filing.undo(req.params.id), stack: cards.stack() }));

  app.get("/api/threads", async () => threads.tree(clock.now(), settings.tz()));
  app.post<{ Params: { id: string } }>("/api/threads/:id/rename", async (req) => {
    const { title } = z.object({ title: z.string().min(1).max(80) }).parse(req.body);
    threads.rename(req.params.id, title, "user");
    return threads.tree(clock.now(), settings.tz());
  });
  app.post("/api/threads/merge", async (req) => {
    const b = z.object({ thread_ids: z.array(z.string()).min(1), into: z.string() }).parse(req.body);
    threads.merge(b.thread_ids, b.into, "user");
    return threads.tree(clock.now(), settings.tz());
  });
  app.post("/api/threads/move", async (req) => {
    const b = z.object({ item_ids: z.array(z.string()).min(1), thread_id: z.string().optional(), title: z.string().min(1).max(80).optional() }).parse(req.body);
    threads.move(b.item_ids, { thread_id: b.thread_id, title: b.title }, "user");
    return threads.tree(clock.now(), settings.tz());
  });
}
