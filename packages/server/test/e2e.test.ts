import { afterEach, describe, expect, it, vi } from "vitest";
import { atLocal } from "@ava/shared";
import type { TalkEvent } from "../src/conversation/conversation";
import { addItem, hours, makeApp, ScriptedProvider, type TestApp } from "./helpers";

const NY = "America/New_York";
let t: TestApp;
afterEach(() => t?.close());

const blank = { stated: true, thread: null, parent_item_id: null, thread_id: null, other_thread_ids: [], item_ids: [], new_title: null, item_id: null, item_type: null, title: null, status: null, due_local: null, start_local: null, end_local: null, project_title: null, importance: null, tags: [], kind: null, course: null, estimate_minutes: null, to_person: null, next_step: null, notes: null, belief_area: null, belief_statement: null, belief_provenance: null, belief_confidence: null };

describe("brain dump to filed items", () => {
  it("files what he stated, asks about the rest as cards, and undoes per item", async () => {
    let psId = "";
    const provider = new ScriptedProvider({
      "conversation.extract": () => ({
        changes: [
          { ...blank, op: "create_item", summary: "New quiz: CMPSC 465 Quiz 4, Thu 10:10", quote: "quiz 4 is thursday at ten ten", item_type: "task", title: "CMPSC 465 Quiz 4", due_local: "2026-10-08T10:10", kind: "quiz", course: "CMPSC 465", thread: "Midterm week" },
          { ...blank, op: "complete_item", summary: "Problem set 5 is done", quote: "I finished the problem set", item_id: psId },
          { ...blank, op: "add_belief", summary: "Practice problems work better than re-reading", quote: "re-reading slides doesn't help", belief_area: "study", belief_statement: "Practice problems work better for you than re-reading slides.", belief_provenance: "stated", belief_confidence: 0.8 },
          { ...blank, op: "create_item", summary: "Promise to Riya: send the robotics slides", quote: "I told Riya I'd send the slides", item_type: "commitment", title: "Send Riya the robotics slides", to_person: "Riya" },
          { ...blank, op: "create_item", summary: "Reading for MATH 486 by Friday", quote: "should probably do the reading before Friday's class", item_type: "task", title: "MATH 486 reading", due_local: "2026-10-09T09:00", stated: false },
          { ...blank, op: "add_belief", summary: "Mornings are hard for deep work", quote: "I never get anything done before ten", belief_area: "routines", belief_statement: "Mornings before ten don't work for deep work.", belief_provenance: "inferred", belief_confidence: 0.5, stated: false },
        ],
      }),
      "conversation.reply": "Filed. Two things need you; they're on top.",
      "affirmation.check": { praise_sentence_indices: [] },
    });
    t = makeApp({ at: atLocal("2026-10-05", "20:00", NY).toISOString(), provider });
    psId = addItem(t.svc, { type: "task", title: "MATH 486 Problem Set 5", due_at: atLocal("2026-10-06", "23:59", NY).toISOString() }).id;

    const events: TalkEvent[] = [];
    await t.svc.conversation.send({ text: "ok so quiz 4 is thursday at ten ten, I finished the problem set, re-reading slides doesn't help, I told Riya I'd send the slides, and the reading before Friday", input_kind: "dictated", speak: false }, (e) => events.push(e));

    expect(events.find((e) => e.type === "filed")).toEqual({ type: "filed", filed: 3, needs_you: 2 });
    expect(events.some((e) => e.type === "module")).toBe(false);
    expect((events.find((e) => e.type === "done") as Extract<TalkEvent, { type: "done" }>).turn.text).toBe("Filed. Two things need you; they're on top.");

    // Stated things are filed straight away, under a thread, with their deadline wakes.
    const quiz = t.svc.items.list({ open: true }).find((i) => i.title === "CMPSC 465 Quiz 4")!;
    expect(quiz.due_at).toBe(atLocal("2026-10-08", "10:10", NY).toISOString());
    expect(t.svc.threads.get(quiz.thread_id!)?.title).toBe("Midterm week");
    expect(t.svc.scheduler.pending({ kinds: ["deadline"] }).some((w) => w.item_ids.includes(quiz.id))).toBe(true);
    expect(t.svc.items.get(psId)?.status).toBe("done");
    expect(t.svc.beliefs.list({}).some((b) => b.statement.startsWith("Practice problems"))).toBe(true);
    // Another person and an inferred date wait for him; nothing was created for them yet.
    expect(t.svc.items.list({ open: true }).some((i) => i.title === "Send Riya the robotics slides" || i.title === "MATH 486 reading")).toBe(false);

    // The stack: the filing summary first, then a card for each thing that needs him. The inference is held back.
    const stack = t.svc.cards.stack();
    expect(stack.cards[0]).toMatchObject({ kind: "know", title: "Filed 3 things, 2 need you" });
    const picks = stack.cards.filter((c) => c.kind === "pick");
    expect(picks.map((c) => c.title).sort()).toEqual(["Promise to Riya: send the robotics slides?", "Reading for MATH 486 by Friday?"]);
    expect(stack.cards.some((c) => c.title.includes("Mornings"))).toBe(false);

    // Opening the summary shows what was filed, with undo per item.
    const layer = t.svc.cards.layer2(stack.cards[0].id);
    expect(layer.filed.filter((f) => f.status === "filed").map((f) => f.summary)).toEqual(expect.arrayContaining(["New quiz: CMPSC 465 Quiz 4, Thu 10:10", "Problem set 5 is done"]));
    const quizEntry = layer.filed.find((f) => f.summary.startsWith("New quiz"))!;
    t.svc.filing.undo(quizEntry.proposal_id);
    expect(t.svc.items.get(quiz.id)).toBeNull();
    expect(t.svc.scheduler.pending({ kinds: ["deadline"] }).some((w) => w.item_ids.includes(quiz.id))).toBe(false);
    expect(t.svc.cards.layer2(stack.cards[0].id).filed.find((f) => f.proposal_id === quizEntry.proposal_id)?.status).toBe("undone");
    const psEntry = layer.filed.find((f) => f.summary === "Problem set 5 is done")!;
    t.svc.filing.undo(psEntry.proposal_id);
    expect(t.svc.items.get(psId)?.status).toBe("todo");

    // Saying yes to the Riya card files it, under the people thread.
    const riya = picks.find((c) => c.title.startsWith("Promise to Riya"))!;
    await t.svc.cards.respond(riya.id, "yes");
    const promise = t.svc.items.list({ open: true }).find((i) => i.title === "Send Riya the robotics slides")!;
    expect(t.svc.threads.get(promise.thread_id!)?.title).toBe("People to get back to");
  });

  it("keeps one affirmation within budget and trims the next, also from the stored raw reply", async () => {
    const provider = new ScriptedProvider({
      "conversation.extract": { changes: [] },
      "conversation.reply": (_p, n) =>
        n === 0 ? "Good call. The quiz goes first." : `Love that idea. <show>{"key":"n2","type":"note","title":"Next","body":"Then the essay."}</show> The essay comes after.`,
      "affirmation.check": { praise_sentence_indices: [] },
    });
    t = makeApp({ provider });
    const turns: string[] = [];
    for (const text of ["quiz first?", "and then the essay"]) {
      const events: TalkEvent[] = [];
      await t.svc.conversation.send({ text, input_kind: "typed", speak: false }, (e) => events.push(e));
      turns.push((events.find((e) => e.type === "done") as Extract<TalkEvent, { type: "done" }>).turn.text);
    }
    expect(turns[0]).toBe("Good call. The quiz goes first.");
    expect(turns[1]).toBe("The essay comes after.");
    const row = t.svc.db.get<{ raw_enc: string }>("SELECT raw_enc FROM turns WHERE role = 'ava' ORDER BY created_at DESC, rowid DESC LIMIT 1")!;
    const raw = t.svc.cipher.decOpt(row.raw_enc) ?? "";
    expect(raw).not.toContain("Love that");
    expect(raw).toContain('<show>{"key":"n2"');
  });
});

describe("wake to validated message", () => {
  it("sends a model-drafted message whose facts are rendered from state", async () => {
    let quizId = "";
    const provider = new ScriptedProvider({
      "wake.rank_and_draft": () => ({
        messages: [
          {
            candidate: 0,
            headline: `{{item:${quizId}.title}} is due {{item:${quizId}.due}}`,
            because: `{{item:${quizId}.title}} is {{item:${quizId}.status}} with {{fact:days_left}} to go.`,
            cited_item_ids: [quizId],
            options: [
              { label: "Make me a practice set", suggestion: 0, executor: null, instructions: null },
              { label: "Remind me tomorrow", suggestion: 1, executor: null, instructions: null },
            ],
            urgency: "today",
          },
        ],
        skipped: [],
        follow_up_wakes: [],
      }),
    });
    t = makeApp({ at: atLocal("2026-10-05", "10:00", NY).toISOString(), provider });
    quizId = addItem(t.svc, { type: "task", title: "CMPSC 465 Quiz 4", due_at: atLocal("2026-10-08", "10:10", NY).toISOString(), data: { kind: "quiz" } }).id;
    const out = await t.svc.wake.run(t.svc.scheduler.event("test"));
    expect(out).toMatch(/1 sent/);
    const m = t.svc.messages.list({ limit: 5 })[0];
    expect(m).toMatchObject({ status: "sent", headline: "CMPSC 465 Quiz 4 is due Thursday at 10:10 am", because: "CMPSC 465 Quiz 4 is not started with 3 days to go.", drafted_by: "model" });
    expect(m.options.map((o) => o.label)).toEqual(["Make me a practice set", "Remind me tomorrow"]);
  });

  it("drops a draft that invents a fact, and logs why", async () => {
    let quizId = "";
    const provider = new ScriptedProvider({
      "wake.rank_and_draft": () => ({
        messages: [
          {
            candidate: 0,
            headline: `{{item:${quizId}.title}} in 3 days`,
            because: `You seem stressed and you haven't started {{item:${quizId}.title}}.`,
            cited_item_ids: [quizId],
            options: [
              { label: "Practice set", suggestion: 0, executor: null, instructions: null },
              { label: "Later", suggestion: 1, executor: null, instructions: null },
            ],
            urgency: "today",
          },
        ],
        skipped: [],
        follow_up_wakes: [],
      }),
    });
    t = makeApp({ at: atLocal("2026-10-05", "10:00", NY).toISOString(), provider });
    quizId = addItem(t.svc, { type: "task", title: "Quiz 4", due_at: atLocal("2026-10-08", "10:10", NY).toISOString() }).id;
    const out = await t.svc.wake.run(t.svc.scheduler.event("test"));
    expect(out).toMatch(/1 failed validation/);
    expect(t.svc.messages.list({ limit: 5 })).toHaveLength(0);
    const fail = t.svc.log.list({ kind: "validator.failed" })[0];
    expect(fail.summary).toMatch(/numbers must come from placeholders/);
    expect(fail.summary).toMatch(/state of mind/);
  });
});

describe("accepted suggestion to executor artifact", () => {
  it("runs a fresh executor session and stores the artifact with a plan-fit report", async () => {
    const provider = new ScriptedProvider({
      "executor.practice_set": (params) => {
        // The executor sees the task spec and item context, never the planner's.
        const content = JSON.stringify((params.messages as unknown[])[0]);
        expect(content).toContain("CMPSC 465 Quiz 4");
        expect(content).not.toContain("planner");
        return {
          artifact: {
            title: "Quiz 4 practice set",
            practice_set: { intro: "Easiest first.", questions: [{ q: "Run Dijkstra from s.", answer: "s=0, a=2, b=3", hint: null }] },
            draft: null,
            summary: null,
            outline: null,
            plan: null,
          },
          report: { result: "Twelve problems on shortest paths and MSTs.", plan_fit: { fits: true, note: "Quiz is still Thursday." }, done: true, progress_note: "", next_focus: null },
        };
      },
    });
    t = makeApp({ at: atLocal("2026-10-05", "10:00", NY).toISOString(), provider });
    const quiz = addItem(t.svc, { type: "task", title: "CMPSC 465 Quiz 4", due_at: atLocal("2026-10-08", "10:10", NY).toISOString(), data: { kind: "quiz" } });
    await t.svc.wake.run(t.svc.scheduler.event("test")); // template-drafted deadline nudge
    const m = t.svc.messages.list({ limit: 5 })[0];
    expect(m.status).toBe("sent");
    const practice = m.options.find((o) => o.action.kind === "start_executor")!;
    const r = await t.svc.responder.respond(m.id, "do_it", practice.key);
    expect(r.result?.exec_task_id).toBeTruthy();
    await vi.waitFor(() => expect(t.svc.executors.view(r.result!.exec_task_id!)?.status).toBe("done"));
    const task = t.svc.executors.view(r.result!.exec_task_id!)!;
    expect(task.plan_fit).toEqual({ fits: true, note: "Quiz is still Thursday." });
    expect(task.artifacts[0].body).toMatchObject({ kind: "practice_set", intro: "Easiest first." });
    expect(task.item_id).toBe(quiz.id);
    // Acting on the nudge counts toward the rule's precision.
    expect(t.svc.messages.list({ limit: 5 })[0].acted).toBe(true);
  });
});

describe("dynamic rule proposal, shadow, approval", () => {
  it("proposes from the evening plan, shadows over past snapshots, and only messages after approval", async () => {
    const definition = {
      when: { field: "now.local_hour", op: "between", value: [19, 21.5] },
      for_each: { type: "task", where: { field: "item.kind", op: "eq", value: "quiz" } },
      action: { kind: "suggest", intent: "Start prep for the quiz in the evening window", options: [] },
      cooldown_hours: 20,
    };
    const provider = new ScriptedProvider({
      "planner.evening": {
        plan_note: "Quiz prep in the evening window.",
        blocks: [],
        wake_requests: [],
        rule_proposals: [{ name: "Evening quiz window", evidence: "You acted on 4 of 5 study nudges sent 7-9pm.", definition_json: JSON.stringify(definition), expiry_days: 10, expiry_condition_json: null }],
        question: null,
        belief_proposals: [],
        brief_notes: null,
        threads: [],
      },
    });
    t = makeApp({ at: atLocal("2026-10-01", "20:00", NY).toISOString(), provider });
    addItem(t.svc, { type: "task", title: "Quiz 4", due_at: atLocal("2026-10-12", "10:10", NY).toISOString(), data: { kind: "quiz" } });
    // Three evenings and mornings of history for the shadow run.
    for (let d = 0; d < 3; d++) {
      t.svc.engine.snapshot(t.svc.engine.world(), null);
      t.clock.advance(hours(14));
      t.svc.engine.snapshot(t.svc.engine.world(), null);
      t.clock.advance(hours(10));
    }
    t.clock.set(atLocal("2026-10-04", "21:30", NY));
    const out = await t.svc.planner.evening("wake_test");
    expect(out).toMatch(/1\/1 rules proposed/);

    const proposed = t.svc.rules.list().proposed;
    expect(proposed).toHaveLength(1);
    const rule = proposed[0];
    expect(rule.status).toBe("proposed");
    expect(rule.shadow?.firings.length).toBeGreaterThanOrEqual(2);
    expect(rule.shadow?.firings.every((f) => new Date(f.at).getUTCHours() === 0)).toBe(true); // only the 20:00 local snapshots
    expect(rule.expires_at).toBeTruthy();
    expect(t.svc.rules.isMessagingAllowed(rule.id)).toBe(false);

    // Unapproved: evaluation ignores it.
    t.clock.set(atLocal("2026-10-05", "20:00", NY));
    expect(t.svc.engine.evaluate(t.svc.engine.world(), null).candidates.some((c) => c.rule_id === rule.id)).toBe(false);
    t.svc.rules.approve(rule.id, "user");
    expect(t.svc.rules.isMessagingAllowed(rule.id)).toBe(true);
    expect(t.svc.engine.evaluate(t.svc.engine.world(), null).candidates.some((c) => c.rule_id === rule.id)).toBe(true);
  });

  it("caps new proposals per week and refuses definitions outside the vocabulary", () => {
    t = makeApp();
    const def = (h: number) => ({ when: { field: "now.local_hour", op: "gte", value: h }, action: { kind: "suggest", intent: "Nudge me about it", options: [] } });
    const results = [0, 1, 2, 3].map((i) => t.svc.rules.propose({ name: `Rule ${i}`, evidence: "seen", definition: def(10 + i), created_by: "planner" }));
    expect(results.slice(0, 3).every((r) => r.ok)).toBe(true);
    expect(results[3].ok).toBe(false);
    const bad = t.svc.rules.propose({ name: "Raise caps", evidence: "x", definition: { action: { kind: "suggest", intent: "Raise the daily message cap to 20", options: [] } }, created_by: "planner" });
    expect(bad.ok).toBe(false);
  });
});
