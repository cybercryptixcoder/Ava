import { describe, expect, it } from "vitest";
import { MODULE_TYPES, mergeSpec, parseModuleSpec } from "../src/canvas";

describe("canvas module vocabulary", () => {
  it("accepts a valid options module", () => {
    const r = parseModuleSpec({
      key: "opts",
      type: "options",
      title: "Start the quiz prep",
      options: [
        { key: "o1", label: "Twelve practice problems", action: { kind: "start_executor", executor: "practice_set", instructions: "Easiest first" } },
        { key: "o2", label: "Not now", action: { kind: "none" } },
      ],
      recommended: "o1",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects unknown module types and malformed specs with readable errors", () => {
    const unknown = parseModuleSpec({ key: "x", type: "orb", title: "Nope" });
    expect(unknown.ok).toBe(false);
    const bad = parseModuleSpec({ key: "opts", type: "options", title: "One option", options: [{ key: "o1", label: "Only", action: { kind: "none" } }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(" ")).toMatch(/options/);
  });

  it("covers every module type the interface renders", () => {
    expect(MODULE_TYPES).toHaveLength(14);
  });

  it("merges in-place updates, replacing arrays", () => {
    const merged = mergeSpec({ key: "n", type: "note", title: "A", paragraphs: ["one", "two"] }, { paragraphs: ["three"], title: "B" });
    expect(merged).toEqual({ key: "n", type: "note", title: "B", paragraphs: ["three"] });
  });
});
