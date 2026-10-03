import type { FastifyInstance } from "fastify";
import { OptionActionSchema } from "@ava/shared";
import type { Services } from "../core/services";
import type { TalkEvent } from "../conversation/conversation";
import { LiveSession } from "../voice/live";
import { requestIsAuthed } from "./auth";

/** Conversation, canvas, voice, live mode and the event stream. */
export function registerTalkRoutes(app: FastifyInstance, svc: Services): void {
  // Server-sent events: every open screen refreshes when state changes.
  app.get("/api/events", async (req, reply) => {
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    reply.raw.write(`event: hello\ndata: ${JSON.stringify({ now: svc.clock.now().toISOString() })}\n\n`);
    const off = svc.bus.on((e) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
    req.raw.on("close", () => {
      off();
      clearInterval(ping);
    });
    return reply;
  });

  app.get<{ Querystring: { id?: string } }>("/api/canvas", async (req) => svc.canvas.state(req.query.id ?? svc.canvas.current()));
  app.post("/api/canvas/new", async () => {
    const id = svc.canvas.current(true);
    return svc.canvas.state(id);
  });
  app.post<{ Body: { conversation_id: string } }>("/api/canvas/clear", async (req) => {
    svc.canvas.clear(req.body.conversation_id);
    return svc.canvas.state(req.body.conversation_id);
  });
  app.post<{ Params: { key: string }; Body: { conversation_id: string } }>("/api/canvas/:key/dismiss", async (req) => {
    svc.canvas.remove(req.body.conversation_id, req.params.key);
    svc.canvas.event(req.body.conversation_id, "dismissed", req.params.key, {});
    return { ok: true };
  });
  /** Record an interaction (checking something off, moving a block) so Ava sees it next turn. */
  app.post<{ Params: { key: string }; Body: { conversation_id: string; kind: string; detail?: Record<string, unknown> } }>("/api/canvas/:key/event", async (req) => {
    svc.canvas.event(req.body.conversation_id, req.body.kind, req.params.key, req.body.detail ?? {});
    return { ok: true };
  });
  app.post<{ Params: { key: string }; Body: { conversation_id: string; option: string } }>("/api/canvas/:key/option", async (req) => {
    const m = svc.canvas.get(req.body.conversation_id, req.params.key);
    if (!m || m.data.type !== "options") throw new Error("That options card is gone");
    const opt = m.data.options.find((o) => o.key === req.body.option);
    if (!opt) throw new Error("Unknown option");
    const result = await svc.options.run(OptionActionSchema.parse(opt.action), `canvas:${req.params.key}`);
    svc.canvas.event(req.body.conversation_id, "choose_option", req.params.key, { option: opt.key, label: opt.label });
    return { result, module: svc.canvas.get(req.body.conversation_id, req.params.key) };
  });

  const streamTalk = async (reply: import("fastify").FastifyReply, run: (sink: (e: TalkEvent) => void, signal: AbortSignal) => Promise<void>, raw: import("node:http").IncomingMessage) => {
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    const ac = new AbortController();
    raw.on("close", () => {
      if (!reply.raw.writableEnded) ac.abort();
    });
    const sink = (e: TalkEvent) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    try {
      await run(sink, ac.signal);
    } catch (e) {
      sink({ type: "error", message: (e as Error).message });
      sink({ type: "status", state: "idle" });
    }
    reply.raw.end();
    return reply;
  };

  /** Async mode: dictated or typed text. The response is a stream of events. */
  app.post<{ Body: { text: string; input_kind?: string; conversation_id?: string; speak?: boolean } }>("/api/talk", async (req, reply) => {
    if (!svc.models.available) return reply.code(503).send({ error: "Conversation needs ANTHROPIC_API_KEY. Add it and restart; everything else keeps working without it." });
    return streamTalk(
      reply,
      (sink, signal) => svc.conversation.send({ text: req.body.text, input_kind: req.body.input_kind ?? "typed", conversation_id: req.body.conversation_id, speak: req.body.speak }, sink, signal),
      req.raw,
    );
  });

  /** Upload an audio file; Ava transcribes it and treats it like a dictated message. */
  app.post("/api/talk/audio", async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "Attach an audio file" });
    const buf = await file.toBuffer();
    const id = svc.audio.save(buf, file.mimetype, "upload");
    const text = await svc.voice.transcribeFile(buf, file.mimetype);
    svc.log.info("talk.audio", `Transcribed an uploaded recording (${Math.round(buf.length / 1024)} KB, ${text.split(/\s+/).length} words)`, { audio_id: id });
    if (!text) return reply.code(422).send({ error: "No speech found in that recording" });
    return streamTalk(reply, (sink, signal) => svc.conversation.send({ text, input_kind: "audio" }, sink, signal), req.raw);
  });

  /** Speak an earlier reply on demand (the play control when autoplay is off). */
  app.post<{ Params: { id: string } }>("/api/turns/:id/speak", async (req, reply) => {
    const t = svc.db.get<{ raw_enc: string | null; text_enc: string; meta: string }>("SELECT raw_enc, text_enc, meta FROM entries WHERE id = ? AND kind = 'turn'", [req.params.id]);
    if (!t) return reply.code(404).send({ error: "No such turn" });
    const meta = JSON.parse(t.meta) as { audio_id?: string | null; cues?: { target: string; at_ms: number }[] | null };
    if (meta.audio_id && svc.audio.load(meta.audio_id)) return { audio_id: meta.audio_id, cues: meta.cues ?? [] };
    const raw = svc.cipher.decOpt(t.raw_enc) ?? svc.cipher.decOpt(t.text_enc) ?? "";
    const words = raw.replace(/<(show|update|propose|style_note)[\s\S]*?<\/\1>|<remove[^>]*\/>/g, "");
    const r = await svc.voice.renderAsync(words, { purpose: "replay", operational: false });
    if (!r) return reply.code(503).send({ error: "No text-to-speech provider is set up" });
    svc.conversation.setTurnAudio(req.params.id, r.audio_id, r.cues);
    return { audio_id: r.audio_id, cues: r.cues, duration_ms: r.duration_ms };
  });

  app.post<{ Params: { id: string } }>("/api/brief/:id/speak", async (req, reply) => {
    const b = svc.brief.view(req.params.id);
    if (!b) return reply.code(404).send({ error: "No such brief" });
    if (b.audio_id && svc.audio.load(b.audio_id)) {
      const a = svc.audio.load(b.audio_id)!;
      return { audio_id: b.audio_id, cues: (a.timings?.cues as unknown[]) ?? [] };
    }
    const r = await svc.voice.renderAsync(b.spoken, { purpose: "brief", operational: true });
    if (!r) return reply.code(503).send({ error: "No text-to-speech provider is set up" });
    svc.db.run("UPDATE briefs SET audio_id = ? WHERE id = ?", [r.audio_id, b.id]);
    return { audio_id: r.audio_id, cues: r.cues, duration_ms: r.duration_ms };
  });

  app.get<{ Params: { id: string } }>("/api/audio/:id", async (req, reply) => {
    const a = svc.audio.load(req.params.id);
    if (!a) return reply.code(404).send({ error: "Audio expired or missing" });
    reply.header("content-type", a.mime).header("cache-control", "private, max-age=86400");
    return reply.send(a.audio);
  });
  app.get<{ Params: { id: string } }>("/api/audio/:id/timings", async (req, reply) => {
    const a = svc.audio.load(req.params.id);
    if (!a) return reply.code(404).send({ error: "Audio expired or missing" });
    return a.timings;
  });

  // ------------------------------------------------------------------ voice settings and audition
  app.get("/api/voice/providers", async () => ({
    tts: svc.voice.providers(),
    stt: Object.values(svc.voice.stt).map((s) => ({ id: s.id, label: s.label, available: s.available() })),
    choice: { async: svc.voice.choice("async"), live: svc.voice.choice("live") },
    live_models: [svc.cfg.models.live, svc.cfg.models.liveFast],
  }));
  app.get<{ Querystring: { provider: "elevenlabs" | "cartesia" } }>("/api/voice/voices", async (req) => svc.voice.voices(req.query.provider));
  app.get("/api/voice/audition/lines", async () => svc.voice.auditionLines());
  app.post<{ Body: { provider: "elevenlabs" | "cartesia"; model: string; voice_id: string; line: string } }>("/api/voice/audition", async (req) =>
    svc.voice.audition(req.body.provider, req.body.model, req.body.voice_id, req.body.line),
  );

  // ------------------------------------------------------------------ live mode
  app.get<{ Querystring: { conversation_id?: string; model?: string } }>("/api/live", { websocket: true }, (socket, req) => {
    if (!requestIsAuthed(req, svc)) {
      socket.send(JSON.stringify({ type: "error", message: "Sign in first" }));
      socket.close();
      return;
    }
    const session = new LiveSession(
      svc,
      (msg) => {
        if (socket.readyState !== socket.OPEN) return;
        if (Buffer.isBuffer(msg)) socket.send(msg);
        else socket.send(JSON.stringify(msg));
      },
      { conversation_id: req.query.conversation_id, model: req.query.model },
    );
    session.start().catch((e) => {
      socket.send(JSON.stringify({ type: "error", message: (e as Error).message }));
      socket.close();
    });
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) session.audio(data);
      else {
        try {
          session.control(JSON.parse(data.toString()));
        } catch {
          /* ignore malformed control */
        }
      }
    });
    socket.on("close", () => session.close());
  });
}
