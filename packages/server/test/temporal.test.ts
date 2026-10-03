import { afterEach, describe, expect, it } from "vitest";
import { atLocal } from "@ava/shared";
import { makeApp, ScriptedProvider, type TestApp } from "./helpers";

const NY = "America/New_York";
let t: TestApp;
afterEach(() => t?.close());

const gist = { gist: "A slice of the log.", keywords: ["k"], entities: [], importance: 0.5 };

describe("temporal facts (L2)", () => {
  it("a contradicting fact supersedes the old one; nothing is overwritten and the decision is logged", async () => {
    const provider = new ScriptedProvider({
      "memory.gist": gist,
      "memory.facts": (_p, n) =>
        n === 0
          ? { facts: [{ statement: "The CMPSC 465 quiz is on October 15.", keywords: ["quiz"], entities: ["CMPSC 465"], refers_at: "2026-10-15", entry_ids: [], provenance: "stated", confidence: 0.9, importance: 0.6 }] }
          : { facts: [{ statement: "The CMPSC 465 quiz moved to October 20.", keywords: ["quiz"], entities: ["CMPSC 465"], refers_at: "2026-10-20", entry_ids: [], provenance: "stated", confidence: 0.9, importance: 0.6 }] },
      "memory.contradict": (p) => {
        const body = JSON.parse(String((p.messages as { content: string }[])[0].content)) as { new: { id: string }[]; existing: { id: string }[] };
        return { pairs: [{ new_id: body.new[0].id, supersedes: [body.existing[0].id], reason: "the quiz date moved" }] };
      },
    });
    t = makeApp({ at: atLocal("2026-10-05", "20:00", NY).toISOString(), provider });

    t.svc.memory.append({ kind: "turn", source: "conversation", role: "user", text: "the quiz is on October 15" });
    const first = await t.svc.memoryProcessor.run({ maxBatches: 5 });
    expect(first.facts).toBe(1);
    const f1 = t.svc.db.get<{ id: string }>("SELECT id FROM facts LIMIT 1")!;

    t.clock.set(atLocal("2026-10-05", "20:11", NY).toISOString());
    t.svc.memory.append({ kind: "turn", source: "conversation", role: "user", text: "actually, the quiz moved to October 20" });
    const second = await t.svc.memoryProcessor.run({ maxBatches: 5 });
    expect(second.facts).toBe(1);

    const old = t.svc.db.get<{ status: string; valid_to: string | null; superseded_by: string | null; statement_enc: string }>("SELECT * FROM facts WHERE id = ?", [f1.id])!;
    expect(old.status).toBe("superseded");
    expect(old.valid_to).not.toBeNull();
    expect(old.superseded_by).not.toBeNull();
    // The old row is intact and readable — replaced, never overwritten.
    expect(t.svc.cipher.decOpt(old.statement_enc)).toContain("October 15");
    const newer = t.svc.db.get<{ id: string; status: string }>("SELECT id, status FROM facts WHERE id != ?", [f1.id])!;
    expect(newer.status).toBe("current");
    expect(old.superseded_by).toBe(newer.id);

    const logRow = t.svc.db.get<{ summary: string; data: string }>("SELECT summary, data FROM log WHERE kind = 'memory.supersede' ORDER BY rowid DESC LIMIT 1")!;
    expect(logRow.summary).toContain("moved to October 20");
    expect((JSON.parse(logRow.data) as { old_id: string }).old_id).toBe(f1.id);
  });
});

describe("forget closure", () => {
  it("facts that lose their last raw source are removed; covering episodes go stale", async () => {
    let eId = "";
    const provider = new ScriptedProvider({
      "memory.gist": gist,
      "memory.facts": () => ({ facts: [{ statement: "The I-20 appointment is on Friday.", keywords: ["i-20"], entities: [], refers_at: null, entry_ids: [eId], provenance: "stated", confidence: 0.9, importance: 0.5 }] }),
    });
    t = makeApp({ at: atLocal("2026-10-05", "20:00", NY).toISOString(), provider });
    eId = t.svc.memory.append({ kind: "turn", source: "conversation", role: "user", text: "my I-20 appointment is on Friday" });
    await t.svc.memoryProcessor.run({ maxBatches: 5 });
    const f = t.svc.db.get<{ id: string; status: string }>("SELECT id, status FROM facts LIMIT 1")!;
    expect(f.status).toBe("current");
    const ep = t.svc.db.get<{ id: string; stale: number }>("SELECT id, stale FROM episodes LIMIT 1")!;
    expect(ep.stale).toBe(0);

    t.svc.memory.forget([eId], "asked to forget the appointment");
    expect(t.svc.db.get<{ status: string }>("SELECT status FROM facts WHERE id = ?", [f.id])!.status).toBe("removed");
    expect(t.svc.db.get<{ stale: number }>("SELECT stale FROM episodes WHERE id = ?", [ep.id])!.stale).toBe(1);
  });
});

describe("nightly consolidation", () => {
  it("regenerates stale gists from raw, rebuilds the core, and grounds reflections in raw entries", async () => {
    let e1 = "", e2 = "", e3 = "";
    const provider = new ScriptedProvider({
      "memory.gist": (_p, n) => (n === 0 ? { gist: "First gist from raw.", keywords: ["k"], entities: [], importance: 0.4 } : { gist: "Regenerated from the remaining raw only.", keywords: ["k"], entities: [], importance: 0.4 }),
      "memory.facts": { facts: [] },
      "memory.core": { core: "- Consolidated core." },
      "memory.reflections": () => ({ reflections: [{ statement: "He gets his real work done in the morning.", area: "study", entry_ids: [e1, e2, e3], confidence: 0.55 }] }),
    });
    t = makeApp({ at: atLocal("2026-10-05", "20:00", NY).toISOString(), provider });
    e1 = t.svc.memory.append({ kind: "turn", source: "conversation", role: "user", text: "morning sessions go best" });
    e2 = t.svc.memory.append({ kind: "turn", source: "conversation", role: "user", text: "before noon I actually get things done" });
    e3 = t.svc.memory.append({ kind: "turn", source: "conversation", role: "user", text: "early is when the work happens" });
    await t.svc.memoryProcessor.run({ maxBatches: 5 });
    const ep = t.svc.db.get<{ id: string; stale: number }>("SELECT id, stale FROM episodes LIMIT 1")!;
    t.svc.db.run("UPDATE episodes SET stale = 1 WHERE id = ?", [ep.id]);

    const out = await t.svc.consolidation.run("wke_test");
    expect(out).toContain("core rebuilt");

    const g = t.svc.cipher.decOpt(t.svc.db.get<{ gist_enc: string }>("SELECT gist_enc FROM episodes WHERE id = ?", [ep.id])!.gist_enc);
    expect(g).toContain("Regenerated from the remaining raw only");
    expect(t.svc.db.get<{ stale: number }>("SELECT stale FROM episodes WHERE id = ?", [ep.id])!.stale).toBe(0);

    expect(t.svc.core.latest()!.text).toContain("Consolidated core");
    const raw = t.svc.db.get<{ text_enc: string }>("SELECT text_enc FROM cores ORDER BY version DESC LIMIT 1")!;
    expect(raw.text_enc).not.toContain("Consolidated core");

    const b = t.svc.beliefs.list({}).find((x) => x.statement.startsWith("He gets his real work"));
    expect(b?.status).toBe("proposed");
    expect(b?.provenance).toBe("inferred");

    const last = t.svc.memory.getState<{ summary: string }>("consolidation.last")!;
    expect(last.summary).toContain("gists 1 revised");
    expect(last.summary).toContain("1 reflections");

    // The wake is armed exactly once and re-arms after running (idempotent).
    t.svc.scheduler.ensureSystemWakes();
    t.svc.scheduler.ensureSystemWakes();
    expect(t.svc.scheduler.pending({ kinds: ["consolidation"] }).length).toBe(1);
    const due = t.svc.scheduler.pending({ kinds: ["consolidation"] })[0].due_at;
    expect(atLocal("2026-10-06", "03:00", NY).toISOString()).toBe(due);
  });
});
