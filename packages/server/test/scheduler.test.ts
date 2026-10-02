import { afterEach, describe, expect, it } from "vitest";
import { atLocal, toLocal } from "@ava/shared";
import { addItem, makeApp, type TestApp } from "./helpers";

const NY = "America/New_York";
const IST = "Asia/Kolkata";
let t: TestApp;
afterEach(() => t?.close());

describe("scheduler validation", () => {
  it("rejects wakes Ava may not request, in quiet hours, in the past or beyond the horizon", () => {
    t = makeApp({ at: atLocal("2026-10-05", "10:00", NY).toISOString() });
    const s = t.svc.scheduler;
    const req = (kind: string, at: Date) => s.request({ kind: kind as "planner", at, reason: "check", owner: "planner" });
    expect(req("heartbeat", atLocal("2026-10-05", "15:00", NY))).toMatchObject({ ok: false, error: expect.stringMatching(/can't request heartbeat/) });
    expect(req("planner", atLocal("2026-10-05", "23:30", NY))).toMatchObject({ ok: false, error: "Falls in quiet hours" });
    expect(req("planner", atLocal("2026-10-05", "09:00", NY))).toMatchObject({ ok: false });
    expect(req("planner", atLocal("2026-10-20", "12:00", NY))).toMatchObject({ ok: false, error: expect.stringMatching(/horizon/) });
    expect(req("planner", atLocal("2026-10-05", "15:00", NY))).toMatchObject({ ok: true });
    // Every rejection is logged with its reason.
    expect(t.svc.log.list({ kind: "schedule.rejected" }).length).toBe(4);
  });

  it("merges requests within the minimum gap and enforces per-kind budgets", () => {
    t = makeApp({ at: atLocal("2026-10-05", "08:30", NY).toISOString() });
    const s = t.svc.scheduler;
    const a = s.request({ kind: "planner", at: atLocal("2026-10-05", "13:00", NY), reason: "after lunch", owner: "planner", item_ids: ["a"] });
    const b = s.request({ kind: "planner", at: atLocal("2026-10-05", "13:10", NY), reason: "quiz prep", owner: "planner", item_ids: ["b"] });
    expect(a.ok && b.ok && b.merged).toBe(true);
    if (a.ok && b.ok) {
      expect(b.wake.id).toBe(a.wake.id);
      expect(b.wake.item_ids.sort()).toEqual(["a", "b"]);
    }
    // Planner budget is 8 a day by default: 1 used, 7 more spaced out succeed, the next is refused.
    for (let i = 0; i < 7; i++) expect(s.request({ kind: "planner", at: atLocal("2026-10-05", `${14 + i}:00`, NY), reason: `slot ${i}`, owner: "planner" }).ok).toBe(true);
    const over = s.request({ kind: "planner", at: atLocal("2026-10-05", "21:40", NY), reason: "one too many", owner: "planner" });
    expect(over).toMatchObject({ ok: false, error: expect.stringMatching(/planner wake budget/) });
  });

  it("keeps system wakes system-owned: Ava and the user can't cancel them", () => {
    t = makeApp({ at: atLocal("2026-10-05", "10:00", NY).toISOString() });
    t.svc.scheduler.ensureSystemWakes();
    const hb = t.svc.scheduler.pending({ kinds: ["heartbeat"] })[0];
    expect(hb).toBeTruthy();
    expect(() => t.svc.scheduler.cancel(hb.id, "user", "nope")).toThrow(/belongs to the system/);
    expect(() => t.svc.scheduler.move(hb.id, atLocal("2026-10-05", "15:00", NY))).toThrow();
    // Idempotent: still exactly one of each.
    t.svc.scheduler.ensureSystemWakes();
    for (const k of ["heartbeat", "brief", "evening", "weekly"] as const) expect(t.svc.scheduler.pending({ kinds: [k] })).toHaveLength(1);
  });

  it("creates deadline wakes at 14, 3 and 1 days out and cancels them when the item is done", () => {
    t = makeApp({ at: atLocal("2026-10-01", "09:00", NY).toISOString() });
    const essay = addItem(t.svc, { type: "task", title: "Essay", due_at: atLocal("2026-10-20", "23:59", NY).toISOString() });
    const wakes = t.svc.scheduler.pending({ kinds: ["deadline"] }).filter((w) => w.item_ids.includes(essay.id));
    expect(wakes.map((w) => toLocal(w.due_at, NY).toFormat("LL-dd HH:mm")).sort()).toEqual(["10-06 10:00", "10-17 10:00", "10-19 10:00"]);
    t.svc.items.complete(essay.id, "test");
    expect(t.svc.scheduler.pending({ kinds: ["deadline"] }).filter((w) => w.item_ids.includes(essay.id))).toHaveLength(0);
  });
});

describe("time zone switching", () => {
  it("recomputes system wakes in the new zone and keeps local anchors", () => {
    t = makeApp({ at: atLocal("2026-10-05", "10:00", NY).toISOString() });
    t.svc.scheduler.ensureSystemWakes();
    const briefNY = t.svc.scheduler.pending({ kinds: ["brief"] })[0];
    expect(toLocal(briefNY.due_at, NY).toFormat("HH:mm")).toBe("08:30");
    const planner = t.svc.scheduler.request({ kind: "planner", at: atLocal("2026-10-05", "17:00", NY), reason: "check", owner: "planner", anchor: { type: "local", date: "2026-10-05", time: "17:00" } });
    expect(planner.ok).toBe(true);

    t.svc.settings.update({ current_location_id: "bangalore" }, t.clock.now());
    expect(t.svc.settings.tz()).toBe(IST);
    const briefIST = t.svc.scheduler.pending({ kinds: ["brief"] });
    expect(briefIST).toHaveLength(1);
    expect(toLocal(briefIST[0].due_at, IST).toFormat("HH:mm")).toBe("08:30");
    const p = planner.ok ? t.svc.scheduler.get(planner.wake.id)! : null;
    expect(p && toLocal(p.due_at, IST).toFormat("yyyy-LL-dd HH:mm")).toBe("2026-10-05 17:00");
    // Quiet hours now follow Bangalore: 23:30 there is refused.
    const late = t.svc.scheduler.request({ kind: "planner", at: atLocal("2026-10-06", "23:30", IST), reason: "late", owner: "planner" });
    expect(late.ok).toBe(false);
  });
});
