import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import type { Services } from "../core/services";
import { registerAuth } from "./auth";
import { registerCoreRoutes } from "./routes-core";
import { registerDevRoutes } from "./routes-dev";
import { registerMemoryRoutes } from "./routes-memory";
import { registerSourceRoutes } from "./routes-sources";
import { registerTalkRoutes } from "./routes-talk";
import { registerStackRoutes } from "./routes-stack";

export async function buildServer(svc: Services, opts: { logger?: boolean; serveWeb?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 32 * 1024 * 1024, trustProxy: true });
  await app.register(cookie, { secret: svc.cfg.sessionSecret });
  await app.register(multipart, { limits: { fileSize: 512 * 1024 * 1024 } });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  app.setErrorHandler((error, req, reply) => {
    const err = error as Error & { statusCode?: number };
    if (err instanceof ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") });
    const status = err.statusCode;
    if (status && status < 500) return reply.code(status).send({ error: err.message });
    svc.log.error("http.error", `${req.method} ${req.url.split("?")[0]} failed: ${err.message}`);
    return reply.code(400).send({ error: err.message });
  });

  registerAuth(app, svc);
  registerCoreRoutes(app, svc);
  registerTalkRoutes(app, svc);
  registerStackRoutes(app, svc);
  registerSourceRoutes(app, svc);
  registerDevRoutes(app, svc);
  registerMemoryRoutes(app, svc);

  const webDir = svc.cfg.webDistDir;
  if (opts.serveWeb !== false && fs.existsSync(path.join(webDir, "index.html"))) {
    await app.register(fastifyStatic, {
      root: webDir,
      prefix: "/",
      setHeaders: (reply, p) => {
        if (p.endsWith("sw.js") || p.endsWith("index.html") || p.endsWith("manifest.webmanifest")) reply.header("cache-control", "no-cache");
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.type("text/html").sendFile("index.html");
    });
  }
  return app;
}
