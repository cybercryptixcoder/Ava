import { afterEach, describe, expect, it } from "vitest";
import { atLocal } from "@ava/shared";
import type { Candidate } from "../src/rules/candidates";
import { validateMessage, type MessageDraft, type ValidationContext } from "../src/validator/message-validator";
import { addItem, makeApp, type TestApp } from "./helpers";

const NY = "America/New_York";
let t: TestApp;
afterEach(() => t?.close());

function setup() {
  t = makeApp({ at: atLocal("2026-10-05", "10:00", NY).toISOString() });
  const quiz = addItem(t.svc, { type: "task", title: "CMPSC 465 Quiz 4", due_at: atLocal("2026-10-08", "10:10", NY).toISOString(), data: { kind: "quiz" } });
  const other = addItem(t.svc, { type: "task", title: "Unrelated" });
  const candidate: Candidate = {
    rule_id: "builtin.deadline_horizon",
    rule_name: "Deadline horizon",
    tier: "builtin",
    action: { kind: "suggest", intent: "x", options: [] },
    item_ids: [quiz.id],
    facts: { days_left: "3 days" },
    intent: "Get it started",
    suggested_options: [],
    urgency: "today",
    dedupe_key: `builtin.deadline_horizon:${quiz.id}:3`,
    cooldown_hours: 20,
    category: "deadlines",
    priority: 70,
  };
  const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({
    now: t.clock.now(),
    tz: NY,
    getItem: (id) => t.svc.items.get(id),
    projectTitle: () => null,
    ruleAllowsMessaging: (id) => t.svc.rules.isMessagingAllowed(id),
    candidate,
    recentlySent: () => false,
    allowCompletionAck: false,
    ...over,
  });
  const draft = (over: Partial<MessageDraft> = {}): MessageDraft => ({
    rule_id: candidate.rule_id,
    headline: "{{item:" + quiz.id + ".title}} is due {{item:" + quiz.id + ".due}}",
    because: "{{item:" + quiz.id + ".title}} is {{item:" + quiz.id + ".status}} with {{fact:days_left}} to go.",
    cited_item_ids: [quiz.id],
    options: [
      { key: "o1", label: "Make me a practice set", action: { kind: "start_executor", executor: "practice_set", item_id: quiz.id, instructions: "Twelve problems" } },
      { key: "o2", label: "Remind me tomorrow", action: { kind: "snooze_item", item_id: quiz.id, hours: 24 } },
    ],
    urgency: "today",
    ...over,
  });
  return { quiz, other, ctx, draft };
}

describe("message validator", () => {
  it("renders every fact from stored state", () => {
    const { ctx, draft } = setup();
    const r = validateMessage(draft(), ctx());
    expect(r.errors).toEqual([]);
    expect(r.rendered).toEqual({ headline: "CMPSC 465 Quiz 4 is due Thursday at 10:10 am", because: "CMPSC 465 Quiz 4 is not started with 3 days to go." });
  });

  it("rejects facts written outside placeholders", () => {
    const { ctx, draft, quiz } = setup();
    const digits = validateMessage(draft({ because: `{{item:${quiz.id}.title}} is due in 3 days.` }), ctx());
    expect(digits.ok).toBe(false);
    expect(digits.errors.join(" ")).toMatch(/numbers must come from placeholders/);
    const status = validateMessage(draft({ because: `You haven't started {{item:${quiz.id}.title}}.` }), ctx());
    expect(status.errors.join(" ")).toMatch(/states a fact about time or status/);
  });

  it("rejects invented states of mind and praise", () => {
    const { ctx, draft, quiz } = setup();
    const mind = validateMessage(draft({ headline: `You seem stressed about {{item:${quiz.id}.title}}` }), ctx());
    expect(mind.errors.join(" ")).toMatch(/state of mind/);
    const praise = validateMessage(draft({ headline: `Great job on {{item:${quiz.id}.title}}` }), ctx());
    expect(praise.errors.join(" ")).toMatch(/no praise/);
  });

  it("requires real cited items from the rule's findings, and 2 to 4 options", () => {
    const { ctx, draft, quiz, other } = setup();
    const missing = validateMessage(draft({ cited_item_ids: [quiz.id, "itm_nope"] }), ctx());
    expect(missing.errors.join(" ")).toMatch(/does not exist/);
    const foreign = validateMessage(draft({ cited_item_ids: [quiz.id, other.id] }), ctx());
    expect(foreign.errors.join(" ")).toMatch(/isn't part of what the rule found/);
    const none = validateMessage(draft({ because: "Worth a look.", cited_item_ids: [] }), ctx());
    expect(none.errors.join(" ")).toMatch(/must cite at least one real item/);
    const oneOption = validateMessage(draft({ options: [draft().options[0]] }), ctx());
    expect(oneOption.errors.join(" ")).toMatch(/2 to 4 options/);
    const badFact = validateMessage(draft({ because: `{{item:${quiz.id}.title}} with {{fact:hours_left}}` }), ctx());
    expect(badFact.errors.join(" ")).toMatch(/unknown fact/);
  });

  it("rejects a repeat within the cooldown and rules that aren't approved for messaging", () => {
    const { ctx, draft } = setup();
    expect(validateMessage(draft(), ctx({ recentlySent: () => true })).errors.join(" ")).toMatch(/cooldown/);
    expect(validateMessage(draft(), ctx({ ruleAllowsMessaging: () => false })).errors.join(" ")).toMatch(/not an approved, active messaging rule/);
  });
});
