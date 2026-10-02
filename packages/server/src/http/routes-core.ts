import type { FastifyInstance } from "fastify";
import { ChangeSchema, ItemDraftSchema, ItemPatchSchema, ResponseKindSchema } from "@ava/shared";
import type { Services } from "../core/services";
import { exportEverything } from "../core/retention";
import { knowsView } from "./views";

/** Core API: today, items, chips, beliefs, rules, messages, wakes, log, settings, actions. */
export function registerCoreRoutes(app: FastifyInstance, svc: Services): void {
  const emit = (...what: string[]) => svc.bus.emit({ type: "state.changed", what });

  app.get("/api/health", async () => ({ ok: true, profile: svc.cfg.profile, now: svc.clock.now().toISOString() }));

  // ------------------------------------------------------------------ items
  app.get<{ Querystring: { types?: string; open?: string; q?: string; project?: string } }>("/api/items", async (req) => {
    const types = req.query.types ? (req.query.types.split(",") as never) : undefined;
    return svc.items.list({ types, open: req.query.open === "1", q: req.query.q, project_id: req.query.project });
  });

  app.post("/api/items", async (req) => {
    const draft = ItemDraftSchema.parse(req.body);
    const item = svc.items.create(draft, { source: "manual", via: "manual" });
    svc.log.info("item.created", `You added ${draft.type.replace("_", " ")} "${item.title}"`, { item_id: item.id });
    return item;
  });

  app.patch<{ Params: { id: string } }>("/api/items/:id", async (req) => {
    const patch = ItemPatchSchema.parse(req.body);
    const item = svc.items.update(req.params.id, patch, "manual");
    svc.log.info("item.updated", `You edited "${item.title}"`, { item_id: item.id, patch });
    return item;
  });

  /** One-tap check-off: takes effect immediately and cancels related wakes. */
  app.post<{ Params: { id: string } }>("/api/items/:id/complete", async (req) => {
    const item = svc.items.complete(req.params.id, "checkoff");
    svc.log.info("item.completed", `You checked off "${item.title}"`, { item_id: item.id });
    return item;
  });

  app.post<{ Params: { id: string }; Body: { status: string } }>("/api/items/:id/status", async (req) => {
    const item = svc.items.setStatus(req.params.id, req.body.status, "manual");
    svc.log.info("item.status", `You marked "${item.title}" as ${item.status.replace("_", " ")}`, { item_id: item.id });
    return item;
  });

  app.post<{ Params: { id: string }; Body: { hours: number } }>("/api/items/:id/snooze", async (req) => {
    const r = await svc.options.run({ kind: "snooze_item", item_id: req.params.id, hours: Number(req.body.hours) || 24 }, "manual");
    return r;
  });

  app.delete<{ Params: { id: string } }>("/api/items/:id", async (req) => {
    svc.items.remove(req.params.id, "manual");
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/items/:id/history", async (req) => svc.items.historyFor(req.params.id));

  /** The Tasks screen: open work hydrated for display, projects with staleness, and recent completions. */
  app.get("/api/tasks", async () => {
    const now = svc.clock.now();
    const tz = svc.settings.tz();
    const projects = svc.items.list({ types: ["project"] }).filter((p) => p.status !== "dropped");
    const titles = new Map(projects.map((p) => [p.id, p.title]));
    const open = svc.items.list({ open: true, types: ["task", "commitment", "open_loop"] });
    const pending = svc.proposals.pending({ limit: 500 });
    const hyd = (i: (typeof open)[number]) => {
      const h = svc.items.hydrate(i, now, tz, titles);
      const p = pending.find((x) => (x.change as { item_id?: string }).item_id === i.id);
      return p ? { ...h, pending_change: p.summary } : h;
    };
    const since = new Date(now.getTime() - 3 * 86_400_000).toISOString();
    const done = svc.db
      .all<{ id: string }>("SELECT id FROM items WHERE completed_at >= ? AND type IN ('task','commitment','open_loop') AND deleted_at IS NULL ORDER BY completed_at DESC LIMIT 20", [since])
      .map((r) => svc.items.get(r.id)!)
      .filter(Boolean);
    return {
      items: open.map(hyd),
      done: done.map(hyd),
      saved: svc.items.list({ types: ["saved_item"], open: true, limit: 50 }).map((i) => ({ ...svc.items.hydrate(i, now, tz), url: (i.data.url as string) ?? null, platform: (i.data.platform as string) ?? null })),
      projects: projects.map((p) => ({
        ...svc.items.hydrate(p, now, tz),
        next_step: (p.data.next_step as string) ?? null,
        important: p.data.important === true || (p.importance ?? 0) >= 2,
        days_since_touched: Math.floor((now.getTime() - new Date(p.touched_at).getTime()) / 86_400_000),
        open_count: open.filter((i) => i.project_id === p.id).length,
      })),
    };
  });

  // ------------------------------------------------------------------ chips
  app.get<{ Querystring: { origin?: string } }>("/api/proposals", async (req) => svc.proposals.pending({ origin: req.query.origin, limit: 500 }));
  app.get<{ Params: { batch: string } }>("/api/proposals/batch/:batch", async (req) => svc.proposals.batch(req.params.batch));

  app.post<{ Params: { id: string }; Body: { change?: unknown } }>("/api/proposals/:id/accept", async (req) => {
    const change = req.body?.change ? ChangeSchema.parse(req.body.change) : undefined;
    const r = svc.proposals.accept(req.params.id, change);
    emit("proposals", "items", "beliefs");
    return r;
  });

  app.post<{ Params: { id: string } }>("/api/proposals/:id/reject", async (req) => {
    const r = svc.proposals.reject(req.params.id);
    emit("proposals");
    return r;
  });

  app.post<{ Params: { batch: string }; Body: { decision: "accept" | "reject"; ids?: string[] } }>("/api/proposals/batch/:batch", async (req) => {
    const r = svc.proposals.resolveBatch(req.params.batch, req.body.decision, req.body.ids);
    emit("proposals", "items", "beliefs");
    return r;
  });

  // ------------------------------------------------------------------ beliefs and questions
  app.get("/api/knows", async () => knowsView(svc));
  app.post<{ Params: { id: string } }>("/api/beliefs/:id/confirm", async (req) => {
    const b = svc.beliefs.confirm(req.params.id);
    svc.log.info("belief.confirmed", `You confirmed: ${b.statement}`, { belief_id: b.id });
    emit("beliefs");
    return b;
  });
  app.patch<{ Params: { id: string }; Body: { statement?: string; confidence?: number; area?: string } }>("/api/beliefs/:id", async (req) => {
    const b = svc.beliefs.edit(req.params.id, req.body);
    svc.log.info("belief.edited", `You edited a belief: ${b.statement}`, { belief_id: b.id });
    emit("beliefs");
    return b;
  });
  app.delete<{ Params: { id: string } }>("/api/beliefs/:id", async (req) => {
    const b = svc.beliefs.get(req.params.id);
    svc.beliefs.remove(req.params.id);
    svc.log.info("belief.removed", `You removed a belief: ${b?.statement ?? req.params.id}`);
    emit("beliefs");
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { answer: string } }>("/api/questions/:id/answer", async (req) => {
    const r = await svc.questions.answer(req.params.id, String(req.body.answer ?? ""));
    emit("beliefs", "questions", "proposals");
    return r;
  });
  app.post<{ Params: { id: string } }>("/api/questions/:id/dismiss", async (req) => {
    svc.questions.dismiss(req.params.id);
    emit("questions");
    return { ok: true };
  });

  // ------------------------------------------------------------------ rules
  app.get("/api/rules", async () => svc.rules.list());
  app.post<{ Params: { id: string } }>("/api/rules/:id/approve", async (req) => {
    const r = svc.rules.approve(req.params.id, "user");
    emit("rules");
    return r;
  });
  app.post<{ Params: { id: string } }>("/api/rules/:id/reject", async (req) => {
    const r = svc.rules.reject(req.params.id);
    emit("rules");
    return r;
  });
  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>("/api/rules/:id/enabled", async (req) => {
    const r = svc.rules.setEnabled(req.params.id, !!req.body.enabled);
    emit("rules");
    return r;
  });
  app.post<{ Params: { id: string } }>("/api/rules/:id/resume", async (req) => {
    svc.db.run("UPDATE rules SET status = 'active', paused_reason = NULL, updated_at = ? WHERE id = ? AND status IN ('paused','paused_low_precision')", [svc.clock.now().toISOString(), req.params.id]);
    svc.log.info("rule.resumed", `You resumed rule ${svc.rules.row(req.params.id)?.name ?? req.params.id}`);
    emit("rules");
    return svc.rules.view(req.params.id);
  });
  app.patch<{ Params: { id: string }; Body: { name?: string; definition?: unknown; expires_at?: string; evidence?: string } }>("/api/rules/:id", async (req, reply) => {
    const r = svc.rules.edit(req.params.id, req.body);
    if (!r.ok) return reply.code(400).send({ error: r.errors.join("; ") });
    emit("rules");
    return r.rule;
  });
  app.post<{ Params: { id: string }; Body: { days?: number } }>("/api/rules/:id/shadow", async (req) => svc.rules.shadow(req.params.id, { days: req.body?.days }));
  app.post<{ Body: { name: string; evidence?: string; definition: unknown; expiry_days?: number } }>("/api/rules", async (req, reply) => {
    const r = svc.rules.propose({ name: req.body.name, evidence: req.body.evidence ?? "Written by hand", definition: req.body.definition, expiry_days: req.body.expiry_days, created_by: "user" });
    if (!r.ok) return reply.code(400).send({ error: r.errors.join("; ") });
    svc.rules.shadow(r.rule.id);
    emit("rules");
    return svc.rules.view(r.rule.id);
  });

  // ------------------------------------------------------------------ messages
  app.get<{ Querystring: { limit?: string } }>("/api/messages", async (req) => svc.messages.list({ limit: Number(req.query.limit ?? 200) }));
  app.get<{ Params: { id: string } }>("/api/messages/:id", async (req, reply) => svc.messages.get(req.params.id) ?? reply.code(404).send({ error: "No such message" }));
  app.post<{ Params: { id: string }; Body: { response: string; option?: string } }>("/api/messages/:id/respond", async (req) => {
    const response = ResponseKindSchema.parse(req.body.response);
    const r = await svc.responder.respond(req.params.id, response, req.body.option ?? null);
    // Answered from the history screen: its card has done its job.
    if (response !== "not_now") svc.cards.closeRef("message", req.params.id);
    return r;
  });

  // ------------------------------------------------------------------ wakes
  app.get<{ Querystring: { from?: string; to?: string } }>("/api/wakes", async (req) => {
    const now = svc.clock.now();
    const from = req.query.from ? new Date(req.query.from) : new Date(now.getTime() - 86_400_000);
    const to = req.query.to ? new Date(req.query.to) : new Date(now.getTime() + 7 * 86_400_000);
    return svc.scheduler.between(from, to).map((w) => svc.scheduler.view(w));
  });
  app.post<{ Params: { id: string }; Body: { to: string } }>("/api/wakes/:id/move", async (req) => svc.scheduler.view(svc.scheduler.move(req.params.id, new Date(req.body.to))));
  app.post<{ Params: { id: string }; Body: { minutes: number } }>("/api/wakes/:id/snooze", async (req) => {
    const w = svc.scheduler.get(req.params.id);
    if (!w) throw new Error("No such wake");
    return svc.scheduler.view(svc.scheduler.move(req.params.id, new Date(new Date(w.due_at).getTime() + (Number(req.body.minutes) || 30) * 60_000)));
  });
  app.post<{ Params: { id: string } }>("/api/wakes/:id/cancel", async (req) => svc.scheduler.view(svc.scheduler.cancel(req.params.id, "user", "you cancelled it")));

  // ------------------------------------------------------------------ log
  app.get<{ Querystring: { before?: string; kind?: string; q?: string; wake?: string; limit?: string } }>("/api/log", async (req) =>
    svc.log.list({ before: req.query.before ? Number(req.query.before) : undefined, kind: req.query.kind, q: req.query.q, wakeId: req.query.wake, limit: Number(req.query.limit ?? 200) }),
  );
  app.get<{ Params: { id: string } }>("/api/model-calls/:id", async (req, reply) => {
    const r = svc.db.get<Record<string, unknown>>("SELECT * FROM model_calls WHERE id = ?", [req.params.id]);
    if (!r) return reply.code(404).send({ error: "No such call" });
    return { ...r, input: svc.cipher.decJson(r.input_enc as string, null), output: svc.cipher.decJson(r.output_enc as string, null), input_enc: undefined, output_enc: undefined };
  });

  // ------------------------------------------------------------------ settings
  app.get("/api/settings", async () => ({ settings: svc.settings.get(), location: svc.settings.location() }));
  app.patch("/api/settings", async (req) => {
    const s = svc.settings.update(req.body as Record<string, unknown>, svc.clock.now());
    svc.log.info("settings.changed", `You changed settings: ${Object.keys(req.body as object).join(", ")}`);
    emit("settings");
    return { settings: s, location: svc.settings.location() };
  });
  app.post<{ Body: { id: string } }>("/api/settings/location", async (req) => {
    const s = svc.settings.get();
    if (!s.locations.some((l) => l.id === req.body.id)) throw new Error("Unknown location");
    svc.settings.update({ current_location_id: req.body.id }, svc.clock.now());
    svc.log.info("settings.location", `You switched to ${svc.settings.location().label} (${svc.settings.tz()})`);
    emit("settings", "wakes");
    return { location: svc.settings.location() };
  });

  // ------------------------------------------------------------------ style notes
  app.get("/api/style-notes", async () => svc.conversation.styleNotes());
  app.post<{ Body: { text: string } }>("/api/style-notes", async (req) => {
    svc.conversation.addStyleNote(String(req.body.text), null);
    return svc.conversation.styleNotes();
  });
  app.patch<{ Params: { id: string }; Body: { text?: string; active?: boolean } }>("/api/style-notes/:id", async (req) => {
    svc.conversation.editStyleNote(req.params.id, req.body);
    return svc.conversation.styleNotes();
  });
  app.delete<{ Params: { id: string } }>("/api/style-notes/:id", async (req) => {
    svc.conversation.removeStyleNote(req.params.id);
    return svc.conversation.styleNotes();
  });

  // ------------------------------------------------------------------ executors and external actions
  app.get("/api/exec", async () => svc.executors.list());
  app.post<{ Body: { kind: "practice_set" | "summary" | "draft" | "outline" | "plan"; item_id?: string; instructions: string } }>("/api/exec", async (req) => {
    const t = svc.executors.start({ kind: req.body.kind, item_id: req.body.item_id ?? null, instructions: req.body.instructions, origin: "user", silent: false });
    if (!t) throw new Error("Couldn't start that work");
    return t;
  });
  app.post<{ Params: { id: string } }>("/api/exec/:id/cancel", async (req) => {
    svc.executors.cancel(req.params.id);
    return svc.executors.view(req.params.id);
  });
  app.get<{ Params: { id: string } }>("/api/artifacts/:id", async (req, reply) => svc.executors.artifact(req.params.id) ?? reply.code(404).send({ error: "No such artifact" }));
  app.post<{ Params: { id: string }; Body: { to?: string; subject?: string; body?: string } }>("/api/artifacts/:id/prepare-email", async (req) => {
    const a = svc.executors.artifact(req.params.id);
    if (!a || a.body.kind !== "draft") throw new Error("Only drafts can be sent");
    return svc.actions.prepareEmail({ to: req.body.to ?? a.body.to ?? "", subject: req.body.subject ?? a.body.subject ?? "", body: req.body.body ?? a.body.body }, a.id);
  });
  app.get("/api/actions", async () => svc.actions.list());
  app.patch<{ Params: { id: string }; Body: { to: string; subject: string; body: string } }>("/api/actions/:id", async (req) => svc.actions.edit(req.params.id, req.body));
  app.post<{ Params: { id: string }; Body: { to: string; subject: string; body: string } }>("/api/actions/:id/confirm", async (req) => {
    const r = await svc.actions.confirm(req.params.id, req.body);
    if (r.status !== "pending") svc.cards.closeRef("action", req.params.id);
    return r;
  });
  app.post<{ Params: { id: string } }>("/api/actions/:id/cancel", async (req) => {
    const r = svc.actions.cancel(req.params.id);
    svc.cards.closeRef("action", req.params.id);
    return r;
  });

  // ------------------------------------------------------------------ brief and setup
  app.get<{ Querystring: { id?: string } }>("/api/brief", async (req) => svc.brief.view(req.query.id) ?? null);
  app.get("/api/briefs", async () => svc.db.all("SELECT id, date, drafted_by, created_at FROM briefs ORDER BY date DESC LIMIT 30"));
  app.post("/api/setup/complete", async () => {
    svc.settings.update({ first_run_complete: true }, svc.clock.now());
    return { ok: true };
  });

  // ------------------------------------------------------------------ export
  app.get("/api/export", async (_req, reply) => {
    const data = exportEverything(svc);
    svc.log.info("export", "You exported everything Ava knows");
    reply.header("content-disposition", `attachment; filename="ava-export-${svc.clock.now().toISOString().slice(0, 10)}.json"`);
    return data;
  });
}
