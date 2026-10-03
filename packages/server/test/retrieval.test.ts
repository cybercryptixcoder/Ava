import { afterEach, describe, expect, it } from "vitest";
import { atLocal } from "@ava/shared";
import { makeApp, ScriptedProvider, type TestApp } from "./helpers";
import { parseTimeRange, isTrivial } from "../src/memory/retriever";

const NY = "America/New_York";
let t: TestApp;
afterEach(() => t?.close());

/** Plant raw entries via the real path, then episodes/facts as the processor would write them. */
function plant() {
  t = makeApp({ at: atLocal("2026-10-05", "10:00", NY).toISOString() });
  const conv = t.svc.canvas.current(true);
  const dayA = atLocal("2026-10-01", "09:00", NY).toISOString();
  const dayB = atLocal("2026-10-04", "15:00", NY).toISOString();
  const e1 = t.svc.memory.append({
    kind: "turn",
    source: "conversation",
    role: "user",
    session_id: conv,
    text: "I need to get the I-20 signed before winter break; the office is only open weekdays until four.",
    occurred_at: dayA,
  });
  const e2 = t.svc.memory.append({
    kind: "turn",
    source: "conversation",
    role: "user",
    session_id: conv,
    text: "Also, practice problems work better than re-reading slides for the quiz.",
    occurred_at: dayB,
  });
  const { cipher, db } = t.svc;
  db.run(
    "INSERT INTO episodes (id, source, session_id, start_at, end_at, recorded_at, gist_enc, keywords_enc, entities_enc, importance, version, revised_at) VALUES ('epi_p1','conversation',?,?,?,?,?,?,?,0.7,1,?)",
    [conv, dayA, dayB, dayB, cipher.encrypt("The I-20 office-hours errand and quiz-prep preferences."), cipher.encJson(["i-20", "office hours"]), cipher.encJson(["I-20 office"]), dayB],
  );
  db.run("INSERT INTO episode_entries (episode_id, entry_id, position) VALUES ('epi_p1', ?, 0), ('epi_p1', ?, 1)", [e1, e2]);
  // A superseded pair: the deadline was Oct 10, then it moved.
  db.run(
    "INSERT INTO facts (id, statement_enc, keywords_enc, entities_enc, refers_at, recorded_at, valid_from, valid_to, superseded_by, provenance, confidence, importance, source, status, created_at) VALUES ('fct_old', ?, ?, ?, NULL, ?, ?, ?, 'fct_new', 'stated', 0.9, 0.6, 'conversation', 'superseded', ?)",
    [cipher.encrypt("The scholarship essay deadline is October 10"), cipher.encJson(["scholarship", "deadline"]), cipher.encJson(["scholarship"]), dayA, dayA, dayB, dayA],
  );
  db.run(
    "INSERT INTO facts (id, statement_enc, keywords_enc, entities_enc, refers_at, recorded_at, valid_from, valid_to, superseded_by, provenance, confidence, importance, source, status, created_at) VALUES ('fct_new', ?, ?, ?, NULL, ?, ?, NULL, NULL, 'stated', 0.9, 0.7, 'conversation', 'current', ?)",
    [cipher.encrypt("The scholarship essay deadline moved to October 24"), cipher.encJson(["scholarship", "deadline"]), cipher.encJson(["scholarship"]), dayB, dayB, dayB],
  );
  db.run(
    "INSERT INTO facts (id, statement_enc, keywords_enc, entities_enc, refers_at, recorded_at, valid_from, valid_to, superseded_by, provenance, confidence, importance, source, status, created_at) VALUES ('fct_office', ?, ?, ?, NULL, ?, ?, NULL, NULL, 'stated', 0.9, 0.8, 'conversation', 'current', ?)",
    [cipher.encrypt("The I-20 office is only open weekdays until 4"), cipher.encJson(["i-20", "hours"]), cipher.encJson(["I-20 office"]), dayA, dayA, dayA],
  );
  db.run("INSERT INTO fact_entries (fact_id, entry_id) VALUES ('fct_office', ?)", [e1]);
  return { e1, e2, conv };
}

describe("memory search and retrieval", () => {
  it("finds planted raw entries through the encrypted-text index", () => {
    const { e1 } = plant();
    const hits = t.svc.memorySearch.search("I-20 office weekdays");
    expect(hits.slice(0, 3).map((h) => h.ref_id)).toContain(e1);
  });

  it("assembles a pack under budget, with current facts and verbatim excerpts", async () => {
    const { e1 } = plant();
    const pack = await t.svc.retriever.retrieve("when is the I-20 office open?");
    expect(pack.via).toBe("direct"); // no model key in this app: the direct pass
    expect(pack.skipped).toBe(false);
    expect(pack.empty).toBe(false);
    expect(pack.facts.map((f) => f.statement)).toContain("The I-20 office is only open weekdays until 4");
    expect(pack.excerpts.some((x) => x.id === e1)).toBe(true); // pulled through the fact's source link
    expect(pack.entries_used).toContain(e1);
    expect(pack.tokens).toBeLessThanOrEqual(6000);
  });

  it("includes superseded history only when the question is about change", async () => {
    plant();
    const current = await t.svc.retriever.retrieve("what is the scholarship deadline?");
    expect(current.facts.some((f) => f.id === "fct_new")).toBe(true);
    expect(current.facts.some((f) => f.id === "fct_old")).toBe(false);
    const historical = await t.svc.retriever.retrieve("what was the scholarship deadline before it moved?");
    expect(historical.facts.some((f) => f.id === "fct_old")).toBe(true);
    expect(historical.facts.some((f) => f.id === "fct_new")).toBe(true);
  });

  it("respects the token budget", async () => {
    plant();
    const pack = await t.svc.retriever.retrieve("everything about the I-20 and scholarships", { budgetTokens: 60 });
    expect(pack.tokens).toBeLessThanOrEqual(60);
  });

  it("fast-paths acknowledgements", async () => {
    plant();
    const pack = await t.svc.retriever.retrieve("ok thanks");
    expect(pack.skipped).toBe(true);
    expect(pack.empty).toBe(false);
    expect(pack.tokens).toBe(0);
  });

  it("answers an empty pack honestly when nothing matches", async () => {
    plant();
    const pack = await t.svc.retriever.retrieve("what did I say about the antarctic expedition?");
    expect(pack.empty).toBe(true);
    expect(pack.entries_used).toEqual([]);
  });

  it("runs as a sub-agent when a model is available, composing only its valid selection", async () => {
    const { e1 } = plant();
    const provider = new ScriptedProvider({
      "memory.retrieve": (_params, n) => (n === 0 ? { done: false, tool: "search", query: "i-20 office" } : { done: true, selected: ["fct_office", e1, "ent_bogus", "fct_missing"] }),
    });
    t.svc.models.setProvider(provider as never);
    const pack = await t.svc.retriever.retrieve("when is the I-20 office open?");
    expect(pack.via).toBe("agent");
    expect(pack.facts.map((f) => f.id)).toContain("fct_office");
    expect(pack.excerpts.map((x) => x.id)).toContain(e1);
    expect(pack.entries_used).not.toContain("ent_bogus");
    expect(provider.calls.filter((c) => c.purpose === "memory.retrieve")).toHaveLength(2);
  });

  it("parses time references into search ranges that actually constrain the search", () => {
    const { e1 } = plant();
    const now = t.clock.now();
    const sept = parseTimeRange("what did I say in September?", now, NY);
    expect(sept.since).toBe(atLocal("2026-09-01", "00:00", NY).toISOString());
    expect(sept.until).toBe(atLocal("2026-10-01", "00:00", NY).toISOString());
    const lastMonth = parseTimeRange("what happened last month?", now, NY);
    expect(lastMonth.since).toBe(sept.since);
    expect(lastMonth.until).toBe(sept.until);
    expect(isTrivial("ok")).toBe(true);
    expect(isTrivial("what did we decide about the deadline?")).toBe(false);
    // The range really excludes the October entry and includes it where it belongs.
    const hitsSept = t.svc.memorySearch.search("I-20", { since: sept.since, until: sept.until });
    expect(hitsSept.map((h) => h.ref_id)).not.toContain(e1);
    const hitsOct = t.svc.memorySearch.search("I-20", { since: atLocal("2026-10-01", "00:00", NY).toISOString(), until: atLocal("2026-10-02", "00:00", NY).toISOString() });
    expect(hitsOct.map((h) => h.ref_id)).toContain(e1);
  });
});
