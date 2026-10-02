import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { z } from "zod";
import type { Services } from "../core/services";

const RespondBody = z.object({ response: z.enum(["yes", "not_now", "already_done", "stop"]), option: z.string().nullable().optional() });

/** The front room: the card stack, its layers and responses, filing undo, and threads. */
export function registerStackRoutes(app: FastifyInstance, svc: Services): void {
  const { cards, filing, threads, clock, settings, items, scheduler } = svc;

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

  // ------------------------------------------------------------------ the calendar

  /** Wakes that count as Ava checking in; internal kinds never appear. */
  const CHECK_IN_KINDS = new Set(["brief", "evening", "weekly", "deadline", "lookahead", "planner", "rule"]);

  /** His events and Ava's planned check-ins for a range of days, and nothing else. */
  app.get<{ Querystring: { date?: string; days?: string } }>("/api/calendar", async (req) => {
    const tz = settings.tz();
    const nowDate = clock.now();
    const days = Math.min(31, Math.max(1, Number(req.query.days) || 1));
    const start = DateTime.fromISO(req.query.date ?? DateTime.fromJSDate(nowDate).setZone(tz).toISODate()!, { zone: tz }).startOf("day");
    const end = start.plus({ days });
    const events = items
      .list({ types: ["event"], starts_between: [start.toUTC().toISO()!, end.toUTC().toISO()!] })
      .filter((e) => e.status !== "cancelled" && e.start_at);
    const checkIns = scheduler.between(start.toUTC().toJSDate(), end.toUTC().toJSDate()).filter((w) => CHECK_IN_KINDS.has(w.kind) && w.status !== "skipped");
    return {
      tz,
      now: nowDate.toISOString(),
      days: Array.from({ length: days }, (_, i) => {
        const from = start.plus({ days: i }).toUTC().toISO()!;
        const to = start.plus({ days: i + 1 }).toUTC().toISO()!;
        return {
          date: start.plus({ days: i }).toISODate()!,
          events: events
            .filter((e) => e.start_at! < to && (e.end_at ?? e.start_at!) >= from)
            .map((e) => ({
              id: e.id,
              title: e.title,
              start: e.start_at!,
              end: e.end_at,
              all_day: e.data.all_day === true,
              category: (e.data.kind as string | undefined) ?? null,
              location: (e.data.location as string | undefined) ?? null,
            })),
          check_ins: checkIns.filter((w) => w.due_at >= from && w.due_at < to).map((w) => scheduler.view(w)),
        };
      }),
    };
  });
}
