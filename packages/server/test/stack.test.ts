import { afterEach, describe, expect, it } from "vitest";
import { atLocal } from "@ava/shared";
import { addItem, hours, makeApp, type TestApp } from "./helpers";

const NY = "America/New_York";
let t: TestApp;
afterEach(() => t?.close());

async function wakeNow(t: TestApp, reason = "check") {
  return t.svc.wake.run(t.svc.scheduler.event(`${reason} ${t.clock.now().toISOString()}`));
}

const pushes = (t: TestApp) => t.svc.log.list({ kind: "push.simulated" }).length;

describe("threads", () => {
  it("files every task, commitment and project under a thread", () => {
    t = makeApp();
    const sop = addItem(t.svc, { type: "project", title: "Grad school applications", status: "active" });
    const draft = addItem(t.svc, { type: "task", title: "Statement of purpose", project_id: sop.id });
    const step = addItem(t.svc, { type: "task", title: "Read it aloud once", parent_id: draft.id });
    const quiz = addItem(t.svc, { type: "task", title: "Quiz 4", data: { course: "CMPSC 465" } });
    const riya = addItem(t.svc, { type: "commitment", title: "Send Riya the slides", data: { to_person: "Riya" } });
    const odd = addItem(t.svc, { type: "task", title: "Renew library card" });
    const title = (id: string) => t.svc.threads.get(t.svc.items.get(id)!.thread_id!)?.title;
    expect(title(draft.id)).toBe("Grad school applications");
    expect(title(step.id)).toBe("Grad school applications");
    expect(title(quiz.id)).toBe("CMPSC 465");
    expect(title(riya.id)).toBe("People to get back to");
    expect(title(odd.id)).toBe("Loose ends");
    // The Everything view nests subtasks under their task.
    const tree = t.svc.threads.tree(t.clock.now(), NY);
    const grad = tree.find((n) => n.title === "Grad school applications")!;
    expect(grad.items.find((i) => i.id === draft.id)?.subtasks.map((s) => s.id)).toEqual([step.id]);
  });

  it("groups further instead of showing more than seven top-level threads", () => {
    t = makeApp();
    for (const c of ["CMPSC 465", "CMPSC 473", "MATH 486", "STAT 318"]) addItem(t.svc, { type: "task", title: `${c} homework`, data: { course: c } });
    for (const p of ["Robotics", "Portfolio", "Ava", "Grad school"]) addItem(t.svc, { type: "project", title: p, status: "active" });
    const top = t.svc.threads.activeTopLevel();
    expect(top.length).toBeLessThanOrEqual(7);
    const coursework = top.find((x) => x.title === "Coursework");
    expect(coursework?.open).toBe(4);
    const tree = t.svc.threads.tree(t.clock.now(), NY);
    expect(tree.find((n) => n.title === "Coursework")?.children.map((c) => c.title).sort()).toEqual(["CMPSC 465", "CMPSC 473", "MATH 486", "STAT 318"]);
  });

  it("renames, merges and splits threads when he says so, with undo", () => {
    t = makeApp();
    const a = addItem(t.svc, { type: "task", title: "Outline the essay", data: { course: "ENGL 202" } });
    const b = addItem(t.svc, { type: "task", title: "Peer review", data: { course: "ENGL 202" } });
    const c = addItem(t.svc, { type: "task", title: "Midterm practice", data: { course: "MATH 486" } });
    const engl = t.svc.items.get(a.id)!.thread_id!;
    const math = t.svc.items.get(c.id)!.thread_id!;
    const f = t.svc.filing.file(
      [
        { change: { op: "rename_thread", thread_id: engl, title: "Essay week" }, summary: "Rename to Essay week", reason: "call it essay week", stated: true },
        { change: { op: "move_to_thread", item_ids: [b.id], thread_title: "Peer review swap" }, summary: "Split out the peer review", reason: "split the peer review out", stated: true },
        { change: { op: "merge_threads", thread_ids: [math], into_thread_id: engl }, summary: "Fold MATH 486 into Essay week", reason: "fold math in", stated: true },
      ],
      { origin: "conversation", evidence_id: null },
    );
    expect(f.filed).toHaveLength(3);
    const title = (id: string) => t.svc.threads.get(t.svc.items.get(id)!.thread_id!)?.title;
    expect(title(a.id)).toBe("Essay week");
    expect(title(b.id)).toBe("Peer review swap");
    expect(title(c.id)).toBe("Essay week");
    // Undo the merge: the math task goes back to its own thread.
    t.svc.filing.undo(f.filed.find((p) => p.change.op === "merge_threads")!.id);
    expect(title(c.id)).toBe("MATH 486");
    t.svc.filing.undo(f.filed.find((p) => p.change.op === "move_to_thread")!.id);
    expect(title(b.id)).toBe("Essay week");
  });
});

describe("the stack", () => {
  it("turns validated messages into cards; queued ones wait for the morning stack", async () => {
    t = makeApp({ at: atLocal("2026-10-05", "23:30", NY).toISOString() });
    addItem(t.svc, { type: "commitment", title: "Send Riya the slides", due_at: atLocal("2026-10-04", "18:00", NY).toISOString(), data: { to_person: "Riya" } });
    await wakeNow(t);
    const m = t.svc.messages.list({ limit: 5 })[0];
    expect(m.status).toBe("queued");
    expect(t.svc.cards.stack().cards).toHaveLength(0);
    t.clock.set(atLocal("2026-10-06", "08:31", NY));
    const stack = t.svc.cards.stack();
    expect(stack.cards).toHaveLength(1);
    expect(stack.cards[0]).toMatchObject({ title: m.headline, why: m.because, has_items: true });
    expect(stack.cards[0].options[0].label).toBe("Draft the reply");
  });

  it("is short and finite, with an all-clear state that names the next check-in", async () => {
    t = makeApp({ at: atLocal("2026-10-05", "10:00", NY).toISOString() });
    t.svc.scheduler.ensureSystemWakes();
    const empty = t.svc.cards.stack();
    expect(empty.cards).toEqual([]);
    expect(empty.all_clear?.next_check_in?.kind).toBe("heartbeat");
    for (let i = 0; i < 8; i++) addItem(t.svc, { type: "task", title: `Thing ${i}` });
    const filed = t.svc.filing.file(
      Array.from({ length: 8 }, (_, i) => ({ change: { op: "create_item" as const, item: { type: "commitment" as const, title: `Promise ${i}` } }, summary: `Promise ${i}`, reason: "said so", stated: true })),
      { origin: "conversation", evidence_id: null },
    );
    expect(filed.needs_you).toHaveLength(8);
    const stack = t.svc.cards.stack();
    expect(stack.cards).toHaveLength(5);
    expect(stack.waiting).toBe(3);
  });
});

describe("responses", () => {
  async function oneCard(at = atLocal("2026-10-05", "10:00", NY)) {
    t = makeApp({ at: at.toISOString() });
    t.svc.scheduler.ensureSystemWakes();
    const quiz = addItem(t.svc, { type: "task", title: "Quiz 4", due_at: atLocal("2026-10-08", "10:10", NY).toISOString(), data: { kind: "quiz" } });
    await wakeNow(t);
    const card = t.svc.cards.stack().cards[0];
    return { quiz, card };
  }

  it("not now: leaves the stack and comes back at Ava's next check-in, no sooner than the minimum", async () => {
    const { card } = await oneCard();
    const r = await t.svc.cards.respond(card.id, "not_now");
    const back = new Date(r.returns_at!);
    expect(back.getTime() - t.clock.now().getTime()).toBeGreaterThanOrEqual(3 * 3_600_000);
    expect(t.svc.cards.stack().cards.some((c) => c.id === card.id)).toBe(false);
    t.clock.set(back);
    const again = t.svc.cards.stack().cards.find((c) => c.id === card.id);
    expect(again?.returns).toBe(1);
    // The response counts for the rule's statistics like before.
    expect(t.svc.messages.list({ limit: 1 })[0].response).toBe("not_now");
  });

  it("already done: updates state at once and cancels the related wakes", async () => {
    const { card, quiz } = await oneCard();
    expect(t.svc.scheduler.pending({ kinds: ["deadline"] }).some((w) => w.item_ids.includes(quiz.id))).toBe(true);
    await t.svc.cards.respond(card.id, "already_done");
    expect(t.svc.items.get(quiz.id)?.status).toBe("done");
    expect(t.svc.scheduler.pending({ kinds: ["deadline"] }).some((w) => w.item_ids.includes(quiz.id))).toBe(false);
    expect(t.svc.cards.stack().cards).toHaveLength(0);
  });

  it("stop suggesting this: the existing less-of-this cooldown", async () => {
    const { card } = await oneCard();
    await t.svc.cards.respond(card.id, "stop");
    expect(t.svc.messages.list({ limit: 1 })[0].response).toBe("less_of_this");
    t.clock.advance(hours(25));
    addItem(t.svc, { type: "task", title: "Quiz 5", due_at: new Date(t.clock.now().getTime() + 3 * 86_400_000).toISOString() });
    const res = t.svc.engine.evaluate(t.svc.engine.world(), null);
    expect(res.candidates.some((c) => c.rule_id === "builtin.deadline_horizon")).toBe(false);
    expect(res.suppressed.some((s) => /less of this/.test(s.reason))).toBe(true);
  });

  it("a swipe never deletes anything", async () => {
    const { card } = await oneCard();
    await t.svc.cards.respond(card.id, "not_now");
    await t.svc.cards.respond(card.id, "not_now").catch(() => null);
    expect(t.svc.db.get("SELECT id FROM cards WHERE id = ?", [card.id])).toBeTruthy();
  });
});

describe("quieter notifications", () => {
  it("pushes only time-sensitive cards, at most two a day, with just the one line", async () => {
    t = makeApp({ at: atLocal("2026-10-05", "09:00", NY).toISOString() });
    // Due tomorrow: the 1-day offset is urgent ("now"). Three of them, three wakes.
    for (const n of [1, 2, 3]) addItem(t.svc, { type: "task", title: `Problem set ${n}`, due_at: atLocal("2026-10-06", `2${n}:00`, NY).toISOString() });
    // A follow-up is not time-sensitive: it joins the stack silently.
    addItem(t.svc, { type: "commitment", title: "Reply to Prof. Lee", due_at: atLocal("2026-10-04", "18:00", NY).toISOString() });
    for (let i = 0; i < 4; i++) {
      await wakeNow(t);
      t.clock.advance(hours(1));
    }
    expect(pushes(t)).toBe(2);
    const pushed = t.svc.log.list({ kind: "push.simulated" }).map((e) => (e.data as { payload: { title: string; body: string } }).payload);
    expect(pushed.every((p) => p.body === "" && p.title.startsWith("Problem set"))).toBe(true);
    expect(t.svc.log.list({ kind: "push.held" }).length).toBeGreaterThanOrEqual(1);
  });

  it("the morning stack and finished work never push", async () => {
    t = makeApp({ at: atLocal("2026-10-05", "08:30", NY).toISOString() });
    addItem(t.svc, { type: "commitment", title: "Reply to Prof. Lee", due_at: atLocal("2026-10-04", "18:00", NY).toISOString() });
    await t.svc.brief.compose("wake_test");
    expect(pushes(t)).toBe(0);
  });
});

describe("the morning stack", () => {
  it("replaces the written brief: a few sentences pointing at the cards", async () => {
    t = makeApp({ at: atLocal("2026-10-05", "23:30", NY).toISOString() });
    addItem(t.svc, { type: "commitment", title: "Send Riya the slides", due_at: atLocal("2026-10-04", "18:00", NY).toISOString() });
    await wakeNow(t);
    t.svc.questions.add({ text: "Does the line follower still matter this semester?", why: "It's important but untouched for nine days." });
    t.clock.set(atLocal("2026-10-06", "08:30", NY));
    await t.svc.brief.compose("wake_test");
    const stack = t.svc.cards.stack();
    expect(stack.cards.map((c) => c.kind).sort()).toEqual(["do", "pick"]);
    expect(stack.morning?.text).toMatch(/^Morning\. Two things in your stack\. First: /);
    expect(stack.morning!.text.split(/[.!?]\s/).length).toBeLessThanOrEqual(3);
    const q = stack.cards.find((c) => c.kind === "pick")!;
    await t.svc.cards.respond(q.id, "yes", "no");
    expect(t.svc.db.get<{ answer: string }>("SELECT answer FROM questions LIMIT 1")?.answer).toBe("No");
  });
});

describe("approvals", () => {
  it("a rule that can message him becomes one Pick card a week, with the shadow run as layer 2", async () => {
    t = makeApp({ at: atLocal("2026-10-05", "20:00", NY).toISOString() });
    const def = (h: number) => ({ when: { field: "now.local_hour", op: "gte", value: h }, action: { kind: "suggest", intent: "Start the quiz prep", options: [] } });
    const ids = [18, 19].map((h) => {
      const r = t.svc.rules.propose({ name: `Evening ${h}`, evidence: "You acted on 4 of 5 nudges sent in the evening.", definition: def(h), created_by: "planner" });
      if (!r.ok) throw new Error(r.errors.join());
      t.svc.rules.shadow(r.rule.id);
      return r.rule.id;
    });
    t.svc.cards.refreshPeriodic();
    t.svc.cards.refreshPeriodic();
    const cards = t.svc.cards.stack().cards.filter((c) => c.title.startsWith("Turn on"));
    expect(cards).toHaveLength(1);
    expect(t.svc.cards.layer2(cards[0].id).shadow).toBeTruthy();
    await t.svc.cards.respond(cards[0].id, "yes");
    expect(t.svc.rules.view(ids[0])?.status).toBe("active");
    // The second waits in Rules until next week.
    t.svc.cards.refreshPeriodic();
    expect(t.svc.cards.stack().cards.some((c) => c.title.startsWith("Turn on"))).toBe(false);
    t.clock.advance(hours(24 * 8));
    t.svc.cards.refreshPeriodic();
    expect(t.svc.cards.stack().cards.some((c) => c.title === 'Turn on "Evening 19"?')).toBe(true);
  });

  it("inferred beliefs surface occasionally, one at a time, as a Pick", () => {
    t = makeApp();
    for (const s of ["Mornings are slow for deep work.", "Short messages land better before noon."]) t.svc.beliefs.add({ area: "routines", statement: s, provenance: "inferred", confidence: 0.5 });
    t.svc.cards.refreshPeriodic();
    t.svc.cards.refreshPeriodic();
    const picks = t.svc.cards.stack().cards.filter((c) => c.kind === "pick");
    expect(picks).toHaveLength(1);
    t.clock.advance(hours(24 * 5));
    t.svc.cards.refreshPeriodic();
    expect(t.svc.cards.stack().cards.filter((c) => c.kind === "pick")).toHaveLength(2);
  });
});
