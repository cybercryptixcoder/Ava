import { afterEach, describe, expect, it } from "vitest";
import { atLocal } from "@ava/shared";
import type { TalkEvent } from "../src/conversation/conversation";
import { makeApp, ScriptedProvider, type TestApp } from "./helpers";

const NY = "America/New_York";
let t: TestApp;
afterEach(() => t?.close());

describe("the forget flow", () => {
  it("previews exactly what leaves, then takes the derived layers with it — immediately", async () => {
    let e1 = "";
    const provider = new ScriptedProvider({
      "memory.gist": (_p, n) => ({ gist: n === 0 ? "First slice." : "Rebuilt from what remains.", keywords: [], entities: [], importance: 0.4 }),
      "memory.facts": () => ({ facts: [{ statement: "The I-20 appointment is on Friday.", keywords: ["i-20"], entities: [], refers_at: null, entry_ids: [e1], provenance: "stated", confidence: 0.9, importance: 0.6 }] }),
    });
    t = makeApp({ at: atLocal("2026-10-05", "20:00", NY).toISOString(), provider });
    e1 = t.svc.memory.append({ kind: "turn", source: "conversation", role: "user", session_id: "cnv_forget", text: "my I-20 appointment is on Friday" });
    const e2 = t.svc.memory.append({ kind: "turn", source: "conversation", role: "user", session_id: "cnv_forget", text: "also I finished the parser today" });
    await t.svc.memoryProcessor.run({ maxBatches: 5 });
    const ep = t.svc.db.get<{ id: string }>("SELECT id FROM episodes LIMIT 1")!;

    const ids = t.svc.forgetFlow.resolve({ entry_ids: [e1] });
    const closure = t.svc.forgetFlow.preview(ids);
    expect(closure.entries.map((x) => x.id)).toEqual([e1]);
    expect(closure.facts.length).toBe(1);
    const fact = t.svc.db.get<{ id: string; status: string }>("SELECT id, status FROM facts WHERE id = ?", [closure.facts[0].id])!;
    expect(closure.episodes_stale.map((x) => x.id)).toEqual([ep.id]);
    expect(closure.episodes_removed).toEqual([]);
    // The preview alone changes nothing.
    expect(t.svc.memory.get(e1)!.deleted_at).toBeNull();

    const out = await t.svc.forgetFlow.apply(ids, "asked to forget it");
    expect(out.summary).toContain("1 raw entry forgotten");
    expect(out.summary).toContain("1 derived fact removed");
    expect(t.svc.memory.get(e1)!.text).toBe("");
    expect(t.svc.memory.get(e1)!.deleted_at).not.toBeNull();
    expect(t.svc.db.get<{ status: string }>("SELECT status FROM facts WHERE id = ?", [fact.id])!.status).toBe("removed");
    // The episode survived, rebuilt from the entry that remains — the old gist text is gone.
    const gist = t.svc.cipher.decOpt(t.svc.db.get<{ gist_enc: string }>("SELECT gist_enc FROM episodes WHERE id = ?", [ep.id])!.gist_enc);
    expect(gist).toContain("Rebuilt from what remains");
    expect(t.svc.db.get<{ stale: number }>("SELECT stale FROM episodes WHERE id = ?", [ep.id])!.stale).toBe(0);
    expect(t.svc.memory.get(e2)!.text).toContain("parser");
    const logRow = t.svc.db.get<{ summary: string }>("SELECT summary FROM log WHERE kind = 'memory.forget_flow' ORDER BY rowid DESC LIMIT 1")!;
    expect(logRow.summary).toContain("1 raw entry forgotten");
  });

  it("removes an episode entirely when all of its raw entries are forgotten", async () => {
    let e1 = "";
    const provider = new ScriptedProvider({ "memory.gist": { gist: "One slice.", keywords: [], entities: [], importance: 0.4 }, "memory.facts": { facts: [] } });
    t = makeApp({ at: atLocal("2026-10-05", "20:00", NY).toISOString(), provider });
    e1 = t.svc.memory.append({ kind: "turn", source: "conversation", role: "user", text: "a lone thought about the pool schedule" });
    await t.svc.memoryProcessor.run({ maxBatches: 5 });
    const ep = t.svc.db.get<{ id: string }>("SELECT id FROM episodes LIMIT 1")!;

    const closure = t.svc.forgetFlow.preview(t.svc.forgetFlow.resolve({ episode_id: ep.id }));
    expect(closure.episodes_removed.map((x) => x.id)).toEqual([ep.id]);
    const out = await t.svc.forgetFlow.apply([e1], "asked to forget the episode");
    expect(out.summary).toContain("1 gist removed");
    expect(t.svc.db.get("SELECT id FROM episodes WHERE id = ?", [ep.id])).toBeUndefined();
  });

  it("by voice: 'forget what I said about X' confirms on a card first; keep keeps, forget forgets", async () => {
    const provider = new ScriptedProvider({ "memory.gist": { gist: "g", keywords: [], entities: [], importance: 0.4 }, "memory.facts": { facts: [] } });
    t = makeApp({ at: atLocal("2026-10-05", "20:00", NY).toISOString(), provider });
    const e1 = t.svc.memory.append({ kind: "turn", source: "conversation", role: "user", text: "my I-20 appointment is on Friday at ten" });
    await t.svc.memoryProcessor.run({ maxBatches: 5 });

    const events: TalkEvent[] = [];
    await t.svc.conversation.send({ text: "forget what I said about the I-20 appointment", input_kind: "typed", speak: false }, (e) => events.push(e));
    expect(provider.count("conversation.reply")).toBe(0); // deterministic: no model call for this
    const done1 = events.find((e) => e.type === "done") as Extract<TalkEvent, { type: "done" }>;
    expect(done1.turn.text).toContain("confirmation on your stack");
    const card1 = t.svc.cards.stack().cards.find((c) => c.title.startsWith("Forget what you said"))!;
    expect(card1).toBeTruthy();
    expect(card1.why).toContain("can't be undone");

    // Keep it: nothing is forgotten.
    await t.svc.cards.respond(card1.id, "yes", "keep");
    expect(t.svc.memory.get(e1)!.deleted_at).toBeNull();

    // Ask again and confirm: now it goes, derived layers included.
    await t.svc.conversation.send({ text: "forget what I said about the I-20 appointment", input_kind: "typed", speak: false }, (e) => events.push(e));
    const card2 = t.svc.cards.stack().cards.find((c) => c.title.startsWith("Forget what you said") && c.id !== card1.id)!;
    expect(card2).toBeTruthy();
    const r = await t.svc.cards.respond(card2.id, "yes", "forget");
    expect(r.summary).toContain("forgotten");
    expect(t.svc.memory.get(e1)!.deleted_at).not.toBeNull();
    expect(t.svc.memory.get(e1)!.text).toBe("");
  });

  it("the transcript view exposes which refs a reply drew on", async () => {
    let e1 = "";
    const provider = new ScriptedProvider({
      "conversation.extract": { changes: [] },
      "memory.retrieve": () => ({ done: true, selected: [e1] }),
      "conversation.reply": "Four o'clock on weekdays.",
      "affirmation.check": { praise_sentence_indices: [] },
    });
    t = makeApp({ at: atLocal("2026-10-05", "20:00", NY).toISOString(), provider });
    e1 = t.svc.memory.append({ kind: "turn", source: "conversation", role: "user", text: "the office closes at four on weekdays", occurred_at: atLocal("2026-10-04", "10:00", NY).toISOString() });
    const conv = t.svc.canvas.current(true);
    await t.svc.conversation.send({ text: "when does the office close?", input_kind: "typed", speak: false }, () => {});
    const ava = t.svc.conversation.turns(conv, 10).find((x) => x.role === "ava")!;
    expect(ava.memory_used).toContain(e1);
  });
});
