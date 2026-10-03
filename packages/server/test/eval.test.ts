import { afterEach, describe, expect, it } from "vitest";
import { atLocal } from "@ava/shared";
import { makeApp, ScriptedProvider, type TestApp } from "./helpers";

const NY = "America/New_York";
let t: TestApp;
afterEach(() => t?.close());

describe("the deterministic retrieval checks", () => {
  it("finds the planted fact, and every ref in the pack exists (no phantoms)", async () => {
    t = makeApp({ at: atLocal("2026-10-05", "20:00", NY).toISOString() });
    const a = t.svc.memory.append({ kind: "turn", source: "conversation", role: "user", text: "the drone permit application goes out on November 2" });
    t.svc.memory.append({ kind: "turn", source: "conversation", role: "user", text: "completely unrelated, I liked the noodle place on College Ave" });
    const pack = await t.svc.retriever.direct("when does the drone permit application go out?", {}, 6000);
    expect(pack.empty).toBe(false);
    // Not invented: the planted entry actually reaches the pack.
    expect(pack.entries_used).toContain(a);
    // No phantoms: every ref in the pack exists in the database.
    for (const x of pack.excerpts) expect(t.svc.memory.get(x.id)).toBeTruthy();
    for (const g of pack.gists) expect(t.svc.db.get("SELECT id FROM episodes WHERE id = ?", [g.id])).toBeTruthy();
    for (const f of pack.facts) expect(t.svc.db.get("SELECT id FROM facts WHERE id = ?", [f.id])).toBeTruthy();
    // And a question about something never stored stays honestly empty.
    const empty = await t.svc.retriever.direct("what did I say about the antarctic station?", {}, 6000);
    expect(empty.empty).toBe(true);
  });
});

describe("the graded evaluation runner", () => {
  it("replays, asks, grades, records — and forgets everything it planted", async () => {
    const provider = new ScriptedProvider({
      "memory.gist": { gist: "fixture gist", keywords: [], entities: [], importance: 0.4 },
      "memory.facts": { facts: [] },
      "memory.retrieve": { done: true, selected: [] },
      "memory.core": { core: "- fixture core" },
      "memory.eval_reply": "Friday, October 9, at ten in the morning, at the international office.",
      "memory.eval_grade": { ok: true, why: "states the date and the place" },
    });
    t = makeApp({ at: atLocal("2026-10-05", "20:00", NY).toISOString(), provider });
    const r = await t.svc.memoryEval.run({ via: "manual" });
    expect(r.total).toBe(3);
    expect(r.passed).toBe(3);
    // Recorded for the developer panel.
    const row = t.svc.db.get<{ passed: number; total: number; via: string }>("SELECT passed, total, via FROM memory_eval_runs ORDER BY at DESC LIMIT 1")!;
    expect(row.passed).toBe(3);
    expect(row.total).toBe(3);
    expect(row.via).toBe("manual");
    // Cleanup: nothing the run planted stays; the real forget path ran.
    expect(t.svc.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM entries WHERE session_id LIKE 'eval:%' AND deleted_at IS NULL`)!.n).toBe(0);
    const logRow = t.svc.db.get<{ summary: string }>("SELECT summary FROM log WHERE kind = 'memory.forget_flow' ORDER BY rowid DESC LIMIT 1")!;
    expect(logRow.summary).toContain("forgotten");
    // Questions went through the real assembly: the reply call carried a memory context block.
    const replyCall = provider.calls.find((c) => c.purpose === "memory.eval_reply")!;
    expect(String((replyCall.params.messages as { content: string }[]).at(-1)!.content)).toContain("<context>");
    // Grading happened once per scenario.
    expect(provider.count("memory.eval_grade")).toBe(3);
  });
});
