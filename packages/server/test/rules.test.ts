import { afterEach, describe, expect, it } from "vitest";
import { atLocal } from "@ava/shared";
import { addItem, hours, makeApp, type TestApp } from "./helpers";

const NY = "America/New_York";
let t: TestApp;
afterEach(() => t?.close());

const ruleIds = (t: TestApp) => t.svc.engine.evaluate(t.svc.engine.world(), null).candidates.map((c) => c.rule_id);

describe("built-in rules", () => {
  it("deadline horizon fires at 3 days out for unstarted work, not at 2, not once started", () => {
    t = makeApp({ at: atLocal("2026-10-05", "10:00", NY).toISOString() });
    const quiz = addItem(t.svc, { type: "task", title: "CMPSC 465 Quiz 4", due_at: atLocal("2026-10-08", "10:10", NY).toISOString(), data: { kind: "quiz" } });
    addItem(t.svc, { type: "task", title: "MATH 486 PS5", due_at: atLocal("2026-10-07", "23:59", NY).toISOString() });
    const res = t.svc.engine.evaluate(t.svc.engine.world(), null);
    const dl = res.candidates.filter((c) => c.rule_id === "builtin.deadline_horizon");
    expect(dl.map((c) => c.item_ids[0])).toEqual([quiz.id]);
    expect(dl[0].facts.days_left).toBe("3 days");
    t.svc.items.setStatus(quiz.id, "started", "test");
    expect(ruleIds(t)).not.toContain("builtin.deadline_horizon");
  });

  it("free block fires shortly before an open hour, with something that fits", () => {
    t = makeApp({ at: atLocal("2026-10-05", "12:50", NY).toISOString() });
    addItem(t.svc, { type: "event", title: "Lunch with Arjun", start_at: atLocal("2026-10-05", "12:00", NY).toISOString(), end_at: atLocal("2026-10-05", "13:00", NY).toISOString() });
    addItem(t.svc, { type: "event", title: "CMPSC 473", start_at: atLocal("2026-10-05", "15:00", NY).toISOString(), end_at: atLocal("2026-10-05", "16:15", NY).toISOString(), data: { kind: "class" } });
    const task = addItem(t.svc, { type: "task", title: "Quiz prep", data: { estimate_minutes: 90 } });
    const c = t.svc.engine.evaluate(t.svc.engine.world(), null).candidates.find((x) => x.rule_id === "builtin.free_block");
    expect(c?.item_ids).toContain(task.id);
    expect(c?.facts.block_minutes).toBe("2 hours");
    expect(c?.queueable).toBe(false);
  });

  it("finish line fires after two days drafted; stale project after a week untouched", () => {
    t = makeApp({ at: atLocal("2026-09-25", "10:00", NY).toISOString() });
    const sop = addItem(t.svc, { type: "task", title: "Statement of purpose", status: "drafted" });
    const robot = addItem(t.svc, { type: "project", title: "Line follower", status: "active", data: { important: true } });
    t.clock.set(atLocal("2026-09-26", "10:00", NY));
    expect(ruleIds(t)).not.toContain("builtin.finish_line");
    t.clock.set(atLocal("2026-10-03", "10:00", NY));
    const ids = t.svc.engine.evaluate(t.svc.engine.world(), null).candidates.map((c) => `${c.rule_id}:${c.item_ids[0]}`);
    expect(ids).toContain(`builtin.finish_line:${sop.id}`);
    expect(ids).toContain(`builtin.stale_project:${robot.id}`);
  });

  it("follow-up fires for an overdue commitment to someone", () => {
    t = makeApp({ at: atLocal("2026-10-05", "10:00", NY).toISOString() });
    const c = addItem(t.svc, { type: "commitment", title: "Send Riya the slides", due_at: atLocal("2026-10-04", "18:00", NY).toISOString(), data: { to_person: "Riya" } });
    const cand = t.svc.engine.evaluate(t.svc.engine.world(), null).candidates.find((x) => x.rule_id === "builtin.follow_up");
    expect(cand?.item_ids).toEqual([c.id]);
    expect(cand?.facts.person).toBe("Riya");
  });

  it("cooldowns and snoozes hold a candidate back", () => {
    t = makeApp({ at: atLocal("2026-10-05", "10:00", NY).toISOString() });
    const quiz = addItem(t.svc, { type: "task", title: "Quiz 4", due_at: atLocal("2026-10-08", "10:10", NY).toISOString() });
    const first = t.svc.engine.evaluate(t.svc.engine.world(), null).candidates.find((c) => c.rule_id === "builtin.deadline_horizon")!;
    t.svc.engine.recordFiring(first, null, "message_sent");
    let res = t.svc.engine.evaluate(t.svc.engine.world(), null);
    expect(res.candidates.some((c) => c.dedupe_key === first.dedupe_key)).toBe(false);
    expect(res.suppressed.some((s) => s.candidate.dedupe_key === first.dedupe_key)).toBe(true);
    // A snooze holds a candidate back too.
    const riya = addItem(t.svc, { type: "commitment", title: "Send Riya the slides", due_at: atLocal("2026-10-04", "18:00", NY).toISOString() });
    t.svc.items.update(riya.id, { data: { snoozed_until: new Date(t.clock.now().getTime() + hours(5)).toISOString() } }, "test");
    res = t.svc.engine.evaluate(t.svc.engine.world(), null);
    expect(res.suppressed.find((s) => s.candidate.item_ids.includes(riya.id))?.reason).toMatch(/snoozed/);
    t.clock.advance(hours(6));
    res = t.svc.engine.evaluate(t.svc.engine.world(), null);
    expect(res.candidates.some((c) => c.item_ids.includes(riya.id))).toBe(true);
  });
});
