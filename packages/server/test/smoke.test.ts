import { afterEach, describe, expect, it } from "vitest";
import { addItem, makeApp, type TestApp } from "./helpers";

let t: TestApp;
afterEach(() => t?.close());

describe("app harness", () => {
  it("builds on an in-memory database with built-in rules seeded", () => {
    t = makeApp();
    expect(t.svc.rules.active("builtin").length).toBe(5);
    const it1 = addItem(t.svc, { type: "task", title: "CMPSC 465 Quiz 4", due_at: "2026-10-08T14:10:00Z", data: { kind: "quiz" } });
    expect(t.svc.items.get(it1.id)?.title).toBe("CMPSC 465 Quiz 4");
  });
});
