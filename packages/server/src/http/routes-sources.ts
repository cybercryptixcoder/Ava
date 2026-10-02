import type { FastifyInstance } from "fastify";
import type { Services } from "../core/services";
import { SessionInputSchema } from "../sources/activity";

/** Sources, OAuth, imports, the activity collector, web push and webhooks. */
export function registerSourceRoutes(app: FastifyInstance, svc: Services): void {
  const { sources } = svc;
  const emit = (...what: string[]) => svc.bus.emit({ type: "state.changed", what });

  app.get("/api/sources", async () => sources.views());
  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>("/api/sources/:id/enabled", async (req) => {
    const s = svc.settings.get();
    svc.settings.update({ sources: { ...s.sources, [req.params.id]: !!req.body.enabled } }, svc.clock.now());
    svc.log.info("source.switched", `${sources.get(req.params.id)?.label ?? req.params.id} switched ${req.body.enabled ? "on" : "off"}`);
    emit("sources");
    return sources.views().find((v) => v.id === req.params.id);
  });
  app.post<{ Params: { id: string } }>("/api/sources/:id/sync", async (req) => ({ summary: await sources.syncNow(req.params.id) }));
  app.delete<{ Params: { id: string } }>("/api/sources/:id/data", async (req) => ({ removed: sources.deleteData(req.params.id) }));

  // Google OAuth (Calendar and Gmail share one grant)
  app.get<{ Querystring: { kind?: "calendar" | "gmail" } }>("/api/oauth/google/start", async (req, reply) => reply.redirect(sources.google.authUrl(req.query.kind ?? "calendar")));
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/api/oauth/google/callback", async (req, reply) => {
    if (req.query.error || !req.query.code || !req.query.state) return reply.redirect(`/settings?section=sources&error=${encodeURIComponent(req.query.error ?? "Google sign-in was cancelled")}`);
    try {
      await sources.google.handleCallback(req.query.code, req.query.state);
      void sources.syncNow("gcal").catch(() => {});
      return reply.redirect("/settings?section=sources&connected=google");
    } catch (e) {
      return reply.redirect(`/settings?section=sources&error=${encodeURIComponent((e as Error).message)}`);
    }
  });
  app.post("/api/google/disconnect", async () => {
    sources.google.disconnect();
    emit("sources");
    return { ok: true };
  });
  app.get("/api/sources/gcal/calendars", async () => ({ calendars: await sources.gcal.calendars(), selected: sources.gcal.selectedCalendarIds() }));
  app.post<{ Body: { ids: string[] } }>("/api/sources/gcal/calendars", async (req) => {
    sources.gcal.setCalendars(req.body.ids);
    return { summary: await sources.syncNow("gcal") };
  });

  // Calendar push notifications from Google
  app.post("/api/webhooks/gcal", async (req, reply) => {
    const ch = req.headers["x-goog-channel-id"] as string | undefined;
    const token = req.headers["x-goog-channel-token"] as string | undefined;
    if (!sources.gcal.verifyWebhook(ch, token)) return reply.code(404).send();
    const state = req.headers["x-goog-resource-state"];
    if (state !== "sync") {
      void sources
        .syncNow("gcal")
        .then((summary) => {
          svc.log.info("source.gcal_push", `Calendar changed: ${summary}`);
          svc.scheduler.event("calendar changed");
        })
        .catch((e) => svc.log.warn("source.gcal_push", `Push sync failed: ${(e as Error).message}`));
    }
    return reply.code(200).send();
  });

  // ICS feeds
  app.get("/api/ics", async () => sources.ics.feeds());
  app.post<{ Body: { url: string; label: string; kind?: "course" | "other" } }>("/api/ics", async (req) => {
    const r = await sources.ics.addFeed(req.body.url, req.body.label, req.body.kind ?? "course");
    emit("items", "sources");
    return r;
  });
  app.delete<{ Params: { id: string } }>("/api/ics/:id", async (req) => {
    sources.ics.removeFeed(req.params.id);
    emit("items", "sources");
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>("/api/ics/:id/enabled", async (req) => {
    sources.ics.setFeedEnabled(req.params.id, !!req.body.enabled);
    return sources.ics.feeds();
  });

  // Imports
  app.post("/api/import/chat", async (req, reply) => {
    const file = await req.file({ limits: { fileSize: 512 * 1024 * 1024 } });
    if (!file) return reply.code(400).send({ error: "Attach your ChatGPT or Claude export (.zip or conversations.json)" });
    const job = sources.chatImport.ingest(await file.toBuffer(), file.filename);
    emit("sources", "proposals");
    return job;
  });
  app.get("/api/import/chat", async () => ({ jobs: sources.chatImport.jobs(), pending: svc.proposals.pending({ origin: "chat_import", limit: 500 }) }));
  app.post("/api/import/saved", async (req, reply) => {
    const file = await req.file({ limits: { fileSize: 256 * 1024 * 1024 } });
    if (!file) return reply.code(400).send({ error: "Attach a bookmarks file or platform export" });
    const r = sources.saved.import(await file.toBuffer(), file.filename);
    emit("items", "sources");
    return r;
  });

  // Wispr Flow (MCP client with OAuth)
  app.post("/api/sources/wispr/connect", async () => sources.wispr.connect());
  app.get<{ Querystring: { code?: string; error?: string } }>("/api/oauth/wispr/callback", async (req, reply) => {
    if (!req.query.code) return reply.redirect(`/settings?section=sources&error=${encodeURIComponent(req.query.error ?? "Wispr sign-in was cancelled")}`);
    try {
      await sources.wispr.finishAuth(req.query.code);
      return reply.redirect("/settings?section=sources&connected=wispr");
    } catch (e) {
      return reply.redirect(`/settings?section=sources&error=${encodeURIComponent((e as Error).message)}`);
    }
  });

  // Activity collector (token-authenticated, separate from the browser session)
  app.post("/api/collector/sessions", async (req, reply) => {
    const auth = String(req.headers.authorization ?? "");
    if (!svc.cfg.collectorToken || auth !== `Bearer ${svc.cfg.collectorToken}`) return reply.code(401).send({ error: "Bad collector token" });
    if (!sources.enabled("activity")) return reply.code(409).send({ error: "Laptop activity is switched off in Settings" });
    const body = SessionInputSchema.parse(req.body);
    const n = sources.activity.ingest(body);
    return { accepted: n };
  });
  app.get("/api/activity/recent", async () => sources.activity.recent(80));

  // Web push
  app.get("/api/push/key", async () => ({ key: svc.cfg.vapid.publicKey, available: svc.channels.available().includes("webpush") }));
  app.post<{ Body: { endpoint: string; keys: { p256dh: string; auth: string } } }>("/api/push/subscribe", async (req) => {
    svc.channels.subscribe(req.body, (req.headers["user-agent"] as string) ?? null);
    svc.log.info("push.subscribed", "A device subscribed to notifications");
    return { ok: true };
  });
  app.post<{ Body: { endpoint: string } }>("/api/push/unsubscribe", async (req) => {
    svc.channels.unsubscribe(req.body.endpoint);
    return { ok: true };
  });
  app.get("/api/push/devices", async () => svc.channels.subscriptions());
  app.post("/api/push/test", async () => {
    await svc.channels.notify("Notifications work", "This is how Ava will reach you.", "/today", "test");
    return { ok: true };
  });
}
