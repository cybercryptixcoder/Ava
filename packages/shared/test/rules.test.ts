import { describe, expect, it } from "vitest";
import { DynamicRuleDefinitionSchema, describeRule, evaluateCondition, evaluateLeaf, type Condition } from "../src/rules";

const resolver = (values: Record<string, unknown>) => (field: string) => values[field];

describe("rule condition DSL", () => {
  it("evaluates leaf operators", () => {
    expect(evaluateLeaf(5, "gt", 3)).toBe(true);
    expect(evaluateLeaf(5, "lte", 4)).toBe(false);
    expect(evaluateLeaf("quiz", "in", ["quiz", "exam"])).toBe(true);
    expect(evaluateLeaf("essay", "not_in", ["quiz", "exam"])).toBe(true);
    expect(evaluateLeaf(19.5, "between", [19, 21.5])).toBe(true);
    expect(evaluateLeaf(22, "between", [19, 21.5])).toBe(false);
    expect(evaluateLeaf(["a", "b"], "contains", "b")).toBe(true);
    expect(evaluateLeaf(undefined, "exists", undefined)).toBe(false);
    expect(evaluateLeaf(null, "not_exists", undefined)).toBe(true);
  });

  it("combines all, any and not", () => {
    const cond: Condition = {
      all: [
        { field: "now.local_hour", op: "between", value: [19, 21.5] },
        { not: { field: "calendar.in_class", op: "eq", value: true } },
        { any: [{ field: "item.kind", op: "eq", value: "quiz" }, { field: "item.kind", op: "eq", value: "exam" }] },
      ],
    };
    expect(evaluateCondition(cond, resolver({ "now.local_hour": 20, "calendar.in_class": false, "item.kind": "quiz" }))).toBe(true);
    expect(evaluateCondition(cond, resolver({ "now.local_hour": 20, "calendar.in_class": true, "item.kind": "quiz" }))).toBe(false);
    expect(evaluateCondition(cond, resolver({ "now.local_hour": 20, "calendar.in_class": false, "item.kind": "essay" }))).toBe(false);
  });

  it("rejects unknown field namespaces and actions outside the vocabulary", () => {
    const bad = DynamicRuleDefinitionSchema.safeParse({
      when: { field: "secrets.password", op: "exists" },
      action: { kind: "suggest", intent: "x", options: [] },
    });
    expect(bad.success).toBe(false);
    const badAction = DynamicRuleDefinitionSchema.safeParse({ action: { kind: "send_email", to: "x@y.z" } });
    expect(badAction.success).toBe(false);
  });

  it("describes rules in plain words, with clock times for hours", () => {
    const def = DynamicRuleDefinitionSchema.parse({
      when: { field: "now.local_hour", op: "between", value: [19, 21.5] },
      for_each: { type: "task", where: { field: "item.kind", op: "in", value: ["quiz", "exam"] } },
      action: { kind: "suggest", intent: "Start prep for the nearest quiz", options: [] },
      cooldown_hours: 20,
    });
    const text = describeRule(def);
    expect(text).toContain("it's between 7 pm and 9:30 pm");
    expect(text).toContain("for each task where");
    expect(text).toContain("Ava suggests: Start prep for the nearest quiz.");
    expect(text).toContain("At most once every 20 hours.");
  });
});

describe("rule sentences", () => {
  it("negates naturally and names statuses as people say them", () => {
    const def = DynamicRuleDefinitionSchema.parse({
      when: { all: [{ field: "calendar.minutes_since_class_ended", op: "between", value: [0, 30] }, { field: "calendar.in_class", op: "eq", value: false }] },
      for_each: { type: "task", where: { field: "item.status", op: "eq", value: "todo" } },
      action: { kind: "prepare", executor: "practice_set", instructions: "Twelve problems." },
    });
    expect(describeRule(def)).toBe(
      "When minutes since a class ended is between 0 and 30 and you're not in class, for each task where status is not started, Ava quietly prepares a practice set: Twelve problems.",
    );
  });
});
