import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Services } from "../core/services";
import { verifyPassword } from "../security/crypto";

const COOKIE = "ava_session";
const SESSION_DAYS = 30;

function sign(value: string, secret: string): string {
  return `${value}.${createHmac("sha256", secret).update(value).digest("base64url")}`;
}

function unsign(signed: string, secret: string): string | null {
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const expected = Buffer.from(sign(value, secret));
  const got = Buffer.from(signed);
  return expected.length === got.length && timingSafeEqual(expected, got) ? value : null;
}

const PUBLIC = [/^\/api\/health$/, /^\/api\/auth\//, /^\/api\/webhooks\//, /^\/api\/collector\//];

function isLoopback(req: FastifyRequest): boolean {
  const ip = req.ip;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/**
 * Single-user authentication: one password (scrypt hash from the
 * environment), server-side sessions in the database, a signed httpOnly
 * cookie. Without a password configured, development mode only accepts
 * requests from this machine.
 */
export function registerAuth(app: FastifyInstance, svc: Services): void {
  const attempts = new Map<string, { n: number; at: number }>();
  const secure = svc.cfg.publicUrl.startsWith("https://");

  const sessionOf = (req: FastifyRequest): string | null => {
    const raw = req.cookies?.[COOKIE];
    if (!raw) return null;
    const id = unsign(raw, svc.cfg.sessionSecret);
    if (!id) return null;
    const row = svc.db.get<{ expires_at: string }>("SELECT expires_at FROM auth_sessions WHERE id = ?", [id]);
    if (!row || new Date(row.expires_at) < new Date()) return null;
    return id;
  };

  const authed = (req: FastifyRequest): boolean => {
    if (!svc.cfg.passwordHash) return !svc.cfg.production && isLoopback(req);
    return !!sessionOf(req);
  };

  app.decorateRequest("authed", false);
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith("/api/")) return;
    const path = req.url.split("?")[0];
    if (PUBLIC.some((p) => p.test(path))) return;
    if (!authed(req)) return reply.code(401).send({ error: "Sign in to continue" });
  });

  app.get("/api/auth/me", async (req) => ({
    authenticated: authed(req),
    password_set: !!svc.cfg.passwordHash,
    profile: svc.cfg.profile,
    owner: svc.cfg.ownerName,
  }));

  app.post<{ Body: { password?: string } }>("/api/auth/login", async (req, reply) => {
    const key = req.ip;
    const a = attempts.get(key);
    const now = Date.now();
    if (a && now - a.at < 60_000 && a.n >= 5) return reply.code(429).send({ error: "Too many attempts. Wait a minute and try again." });
    if (!svc.cfg.passwordHash) return reply.code(400).send({ error: "No password is configured. Set AVA_PASSWORD_HASH (npm run hash-password)." });
    const ok = typeof req.body?.password === "string" && verifyPassword(req.body.password, svc.cfg.passwordHash);
    if (!ok) {
      attempts.set(key, { n: a && now - a.at < 60_000 ? a.n + 1 : 1, at: a && now - a.at < 60_000 ? a.at : now });
      svc.log.warn("auth.failed", "A sign-in attempt failed");
      return reply.code(401).send({ error: "That password didn't match." });
    }
    attempts.delete(key);
    const id = randomBytes(24).toString("base64url");
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    svc.db.run("INSERT INTO auth_sessions (id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?)", [id, new Date().toISOString(), expires.toISOString(), req.headers["user-agent"] ?? null]);
    reply.setCookie(COOKIE, sign(id, svc.cfg.sessionSecret), { httpOnly: true, sameSite: "lax", secure, path: "/", expires });
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const id = sessionOf(req);
    if (id) svc.db.run("DELETE FROM auth_sessions WHERE id = ?", [id]);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });
}

/** For the WebSocket upgrade, which skips the normal hook ordering in some setups. */
export function requestIsAuthed(req: FastifyRequest, svc: Services): boolean {
  if (!svc.cfg.passwordHash) return !svc.cfg.production && isLoopback(req);
  const raw = req.cookies?.[COOKIE];
  if (!raw) return false;
  const id = unsign(raw, svc.cfg.sessionSecret);
  if (!id) return false;
  const row = svc.db.get<{ expires_at: string }>("SELECT expires_at FROM auth_sessions WHERE id = ?", [id]);
  return !!row && new Date(row.expires_at) > new Date();
}
