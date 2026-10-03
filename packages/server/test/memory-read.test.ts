import { afterEach, describe, expect, it } from "vitest";
import { atLocal } from "@ava/shared";
import type { TalkEvent } from "../src/conversation/conversation";
import { makeApp, ScriptedProvider, type TestApp } from "./helpers";

const NY = "America/New_York";
let t: TestApp;
afterEach(() => t?.close());

const seedFact = (app: TestApp, id: string, statement: string, importance = 0.5) => {
  const now = app.svc.clock.now().toISOString();
  app.svc.db.run(
    "INSERT INTO facts (id, statement_enc, keywords_enc, entities_enc, refers_at, recorded_at, provenance, confidence, importance, source, status, created_at) VALUES (?, ?, NULL, NULL, NULL, ?, 'stated', 0.9, ?, 'test', 'current', ?)",
    [id, app.svc.cipher.encrypt(statement), now, importance, now],
  );
};

describe("the conversation read path", () => {
  it("assembles system = instructions then a cached core, message = pack + window + text; logs grounding", async () => {
    let e1Id = "";
    const provider = new ScriptedProvider({
      "conversation.extract": { changes: [] },
      "memory.retrieve": () => ({ done: true, selected: [e1Id] }),
      "memory.core": { core: "- CS student at Penn State.\n- Prefers terse answers." },
      "conversation.reply": "The I-20 office closes at four.",
      "affirmation.check": { praise_sentence_indices: [] },
    });
    t = makeApp({ at: atLocal("2026-10-05", "20:00", NY).toISOString(), provider });
    e1Id = t.svc.memory.append({ kind: "turn", source: "conversation", role: "user", text: "the I-20 office closes at four on weekdays", occurred_at: atLocal("2026-10-04", "10:00", NY).toISOString() });
    seedFact(t, "fct_core01", "Shreyas is a computer science student at Penn State.");
    const conv = t.svc.canvas.current(true);
    t.svc.conversation.saveTurn({ convId: conv, role: "user", mode: "async", text: "anything urgent today?", input_kind: "typed" });
    t.svc.conversation.saveTurn({ convId: conv, role: "ava", mode: "async", text: "Nothing urgent." });

    const events: TalkEvent[] = [];
    await t.svc.conversation.send({ text: "when does the I-20 office close?", input_kind: "typed", speak: false }, (e) => events.push(e));

    // The retriever ran for this message; the core was built on first need.
    expect(provider.count("memory.retrieve")).toBe(1);
    expect(provider.count("memory.core")).toBe(1);

    const reply = provider.calls.filter((c) => c.purpose === "conversation.reply").at(-1)!;
    const system = reply.params.system as { text: string; cache_control?: unknown }[];
    expect(system[0].text).toContain("The person you talk with");
    expect(system.at(-1)!.text).toContain("## The core");
    expect(system.at(-1)!.text).toContain("Prefers terse answers.");
    expect(system.at(-1)!.cache_control).toBeTruthy();
    expect(system.filter((b) => b.cache_control).length).toBe(1); // one cache breakpoint, at the core

    const messages = reply.params.messages as { role: string; content: string }[];
    const last = String(messages.at(-1)!.content);
    expect(last).toContain("<context>");
    expect(last).toContain("<memory>");
    expect(last).toContain("I-20 office closes at four"); // the retrieved excerpt
    expect(last).toContain("when does the I-20 office close?"); // the message itself

    // The window carries the earlier pair verbatim, without duplicating the new message.
    const all = messages.map((m) => String(m.content)).join("\n---\n");
    expect(all).toContain("anything urgent today?");
    expect(all.match(/when does the I-20 office close\?/g)!.length).toBe(1);

    // Grounding: the reply records its refs, and the log carries the segment breakdown.
    const ava = t.svc.memory.list({ kind: "turn", role: "ava", order: "desc", limit: 1 })[0];
    expect((ava.meta.memory_used as string[]) ?? []).toContain(e1Id);
    const logRow = t.svc.db.get<{ summary: string; data: string }>("SELECT summary, data FROM log WHERE kind = 'memory.grounding' ORDER BY rowid DESC LIMIT 1")!;
    expect(logRow.summary).toContain("pack");
    expect(logRow.summary).toContain("window");
    expect((JSON.parse(logRow.data) as { refs: string[] }).refs).toContain(e1Id);
  });

  it("the core is versioned and encrypted at rest", async () => {
    const provider = new ScriptedProvider({ "memory.core": (_p, n) => ({ core: `v${n} core text` }) });
    t = makeApp({ at: atLocal("2026-10-05", "20:00", NY).toISOString(), provider });
    seedFact(t, "fct_core02", "He splits time between State College and Bangalore.");

    expect(await t.svc.core.ensure()).toBe("v0 core text");
    expect(t.svc.core.latest()!.version).toBe(1);
    const raw = t.svc.db.get<{ text_enc: string }>("SELECT text_enc FROM cores ORDER BY version DESC LIMIT 1")!;
    expect(raw.text_enc).not.toContain("v0 core text");

    expect(await t.svc.core.rebuild()).toBe("v1 core text");
    expect(t.svc.core.latest()!.version).toBe(2);
    expect(t.svc.core.versions().length).toBe(2);
    // ensure() now serves the newest version from cache without another model call.
    expect(await t.svc.core.ensure()).toBe("v1 core text");
    expect(provider.count("memory.core")).toBe(2);
  });

  it("the recent window keeps the last turns, capped by count, and drops the newest turn", async () => {
    t = makeApp({ at: atLocal("2026-10-05", "20:00", NY).toISOString() });
    t.svc.settings.update({ memory: { recent_turns: 4 } }, t.svc.clock.now());
    const conv = t.svc.canvas.current(true);
    for (let i = 0; i < 5; i++) {
      t.svc.conversation.saveTurn({ convId: conv, role: "user", mode: "async", text: `message number ${i}`, input_kind: "typed" });
      t.svc.conversation.saveTurn({ convId: conv, role: "ava", mode: "async", text: `reply number ${i}` });
    }
    const w = t.svc.conversation.window(conv);
    const flat = w.map((m) => String(m.content)).join("\n");
    expect(w[0].role).toBe("user");
    expect(flat).toContain("message number 3");
    expect(flat).toContain("message number 4");
    expect(flat).not.toContain("message number 2"); // beyond the count cap
    expect(flat).not.toContain("reply number 4"); // the newest turn is dropped; it travels with the new message
  });
});
