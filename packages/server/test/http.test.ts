import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/http/server";
import { hashPassword } from "../src/security/crypto";
import { addItem, makeApp, type TestApp } from "./helpers";

let t: TestApp;
let server: FastifyInstance;
afterEach(async () => {
  await server?.close();
  t?.close();
});

async function boot(config: Parameters<typeof makeApp>[0] extends infer O ? (O extends { config?: infer C } ? C : never) : never = {}) {
  t = makeApp({ config });
  server = await buildServer(t.svc, { serveWeb: false });
  return server;
}

describe("access control", () => {
  it("without a password, answers only on this machine and never in production", async () => {
    const s = await boot();
    expect((await s.inject({ method: "GET", url: "/api/today", remoteAddress: "127.0.0.1" })).statusCode).toBe(200);
    expect((await s.inject({ method: "GET", url: "/api/today", remoteAddress: "203.0.113.9" })).statusCode).toBe(401);
  });

  it("with a password, requires a signed session cookie and rate-limits guesses", async () => {
    const s = await boot({ passwordHash: hashPassword("open sesame") });
    expect((await s.inject({ method: "GET", url: "/api/today" })).statusCode).toBe(401);
    expect((await s.inject({ method: "POST", url: "/api/auth/login", payload: { password: "nope" } })).statusCode).toBe(401);
    const ok = await s.inject({ method: "POST", url: "/api/auth/login", payload: { password: "open sesame" } });
    expect(ok.statusCode).toBe(200);
    const cookie = ok.cookies[0];
    expect(cookie.httpOnly).toBe(true);
    const me = await s.inject({ method: "GET", url: "/api/today", cookies: { [cookie.name]: cookie.value } });
    expect(me.statusCode).toBe(200);
    const forged = await s.inject({ method: "GET", url: "/api/today", cookies: { [cookie.name]: `${cookie.value.slice(0, -2)}xx` } });
    expect(forged.statusCode).toBe(401);
    for (let i = 0; i < 5; i++) await s.inject({ method: "POST", url: "/api/auth/login", payload: { password: "guess" }, remoteAddress: "198.51.100.7" });
    expect((await s.inject({ method: "POST", url: "/api/auth/login", payload: { password: "open sesame" }, remoteAddress: "198.51.100.7" })).statusCode).toBe(429);
  });

  it("accepts collector sessions only with the token and only when the source is on", async () => {
    const s = await boot({ collectorToken: "tok" });
    const body = { device: "laptop", sessions: [{ app: "Code", title: "shell.c", started_at: "2026-10-05T13:00:00Z", ended_at: "2026-10-05T13:30:00Z", active_seconds: 1700 }] };
    expect((await s.inject({ method: "POST", url: "/api/collector/sessions", payload: body, headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await s.inject({ method: "POST", url: "/api/collector/sessions", payload: body, headers: { authorization: "Bearer tok" } })).statusCode).toBe(409);
    await s.inject({ method: "POST", url: "/api/sources/activity/enabled", payload: { enabled: true } });
    const r = await s.inject({ method: "POST", url: "/api/collector/sessions", payload: body, headers: { authorization: "Bearer tok" } });
    expect(r.json()).toEqual({ accepted: 1 });
    // Window titles are encrypted at rest.
    const row = t.svc.db.get<{ title_enc: string }>("SELECT title_enc FROM activity_sessions LIMIT 1")!;
    expect(row.title_enc).not.toContain("shell.c");
  });
});

describe("core API", () => {
  it("checks an item off immediately and cancels its wakes", async () => {
    const s = await boot();
    const quiz = addItem(t.svc, { type: "task", title: "Quiz 4", due_at: "2026-10-20T14:10:00Z" });
    expect(t.svc.scheduler.pending({ kinds: ["deadline"] }).some((w) => w.item_ids.includes(quiz.id))).toBe(true);
    const r = await s.inject({ method: "POST", url: `/api/items/${quiz.id}/complete` });
    expect(r.statusCode).toBe(200);
    expect(t.svc.items.get(quiz.id)?.status).toBe("done");
    expect(t.svc.scheduler.pending({ kinds: ["deadline"] }).some((w) => w.item_ids.includes(quiz.id))).toBe(false);
  });

  it("exports everything as JSON with decrypted content", async () => {
    const s = await boot();
    addItem(t.svc, { type: "task", title: "Exported task" });
    const r = await s.inject({ method: "GET", url: "/api/export" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Exported task");
  });

  it("runs time simulation on the test profile only", async () => {
    const s = await boot();
    t.svc.scheduler.ensureSystemWakes();
    const r = await s.inject({ method: "POST", url: "/api/dev/clock/advance", payload: { hours: 24 } });
    expect(r.statusCode).toBe(200);
    const kinds = (r.json() as { ran: { kind: string }[] }).ran.map((w) => w.kind);
    expect(kinds).toContain("brief");
    expect(kinds).toContain("evening");
    expect(kinds).toContain("heartbeat");
    expect(t.svc.db.get("SELECT id FROM briefs LIMIT 1")).toBeTruthy();
  });
});
