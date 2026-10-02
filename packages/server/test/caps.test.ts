import { afterEach, describe, expect, it } from "vitest";
import { atLocal } from "@ava/shared";
import { addItem, hours, makeApp, type TestApp } from "./helpers";

const NY = "America/New_York";
let t: TestApp;
afterEach(() => t?.close());

/** Run a wake right now through the real procedure (template drafting, no model). */
async function wakeNow(t: TestApp, reason = "check") {
  const w = t.svc.scheduler.event(`${reason} ${t.clock.now().toISOString()}`);
  return t.svc.wake.run(w);
}

function overdueCommitments(t: TestApp, n: number) {
  return Array.from({ length: n }, (_, i) =>
    addItem(t.svc, { type: "commitment", title: `Promise ${i + 1}`, due_at: atLocal("2026-10-04", "18:00", NY).toISOString(), data: { to_person: `Person ${i + 1}` } }),
  );
}

const statuses = (t: TestApp) => t.svc.messages.list({ limit: 50 }).map((m) => m.status);

describe("caps and quiet hours", () => {
  it("sends at most one message per wake and at most three a day; the rest wait for the brief", async () => {
    t = makeApp({ at: atLocal("2026-10-05", "10:00", NY).toISOString() });
    overdueCommitments(t, 6);
    const perWake: number[] = [];
    for (let i = 0; i < 5; i++) {
      const before = statuses(t).filter((s) => s === "sent").length;
      await wakeNow(t);
      perWake.push(statuses(t).filter((s) => s === "sent").length - before);
      t.clock.advance(hours(1));
    }
    expect(Math.max(...perWake)).toBe(1);
    expect(statuses(t).filter((s) => s === "sent")).toHaveLength(3);
    expect(t.svc.counters.get("messages.unprompted")).toBe(3);
    expect(statuses(t).filter((s) => s === "queued").length).toBeGreaterThan(0);
    expect(t.svc.messages.list({ limit: 50 }).find((m) => m.status === "queued")?.block_reason).toMatch(/daily cap of 3/);
  });

  it("queues during quiet hours and before the morning brief", async () => {
    t = makeApp({ at: atLocal("2026-10-05", "23:30", NY).toISOString() });
    overdueCommitments(t, 1);
    await wakeNow(t);
    expect(t.svc.messages.list({ limit: 5 })[0]).toMatchObject({ status: "queued", block_reason: "quiet hours" });

    t.clock.set(atLocal("2026-10-06", "08:10", NY));
    addItem(t.svc, { type: "commitment", title: "Another promise", due_at: atLocal("2026-10-05", "12:00", NY).toISOString() });
    await wakeNow(t, "morning");
    const latest = t.svc.messages.list({ limit: 5 }).find((m) => m.headline.includes("Another promise"));
    expect(latest?.status).toBe("queued");
    expect(latest?.block_reason).toMatch(/morning brief is at 8:30 am/);
    expect(statuses(t)).not.toContain("sent");
  });

  it("holds urgent messages during class and wakes again right after it", async () => {
    t = makeApp({ at: atLocal("2026-10-06", "10:30", NY).toISOString() });
    addItem(t.svc, { type: "event", title: "CMPSC 465 Lecture", start_at: atLocal("2026-10-06", "10:10", NY).toISOString(), end_at: atLocal("2026-10-06", "11:00", NY).toISOString(), data: { kind: "class" } });
    // Due tomorrow and not started: the deadline horizon's 1-day offset, urgency "now".
    addItem(t.svc, { type: "task", title: "Problem set 5", due_at: atLocal("2026-10-07", "23:59", NY).toISOString() });
    const out = await wakeNow(t);
    expect(out).toMatch(/1 deferred/);
    expect(statuses(t)).not.toContain("sent");
    const after = t.svc.scheduler.pending({ kinds: ["lookahead"] }).find((w) => w.reason.includes("CMPSC 465 Lecture"));
    expect(after && new Date(after.due_at).toISOString()).toBe(atLocal("2026-10-06", "11:05", NY).toISOString());

    t.clock.set(atLocal("2026-10-06", "11:05", NY));
    await t.svc.wake.run(after!);
    expect(statuses(t)).toContain("sent");
  });

  it("logs every decision", async () => {
    t = makeApp({ at: atLocal("2026-10-05", "10:00", NY).toISOString() });
    overdueCommitments(t, 2);
    await wakeNow(t);
    const kinds = new Set(t.svc.log.list({ limit: 200 }).map((e) => e.kind));
    for (const k of ["wake.start", "rules.evaluated", "wake.fallback_draft", "validator.passed", "message.sent", "message.held", "wake.end"]) expect(kinds).toContain(k);
  });
});
