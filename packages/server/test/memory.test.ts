import { afterEach, describe, expect, it } from "vitest";
import { atLocal } from "@ava/shared";
import { makeApp, type TestApp } from "./helpers";

const NY = "America/New_York";
let t: TestApp;
afterEach(() => t?.close());

const appAt = () => makeApp({ at: atLocal("2026-10-05", "10:00", NY).toISOString() });

describe("the raw log", () => {
  it("appends turns verbatim, encrypted at rest, and reads them back in order", () => {
    t = appAt();
    const conv = t.svc.canvas.current(true);
    const u = t.svc.conversation.saveTurn({ convId: conv, role: "user", mode: "async", text: "the I-20 office is only open weekdays until 4", input_kind: "dictated" });
    const e = t.svc.memory.get(u.id)!;
    expect(e.kind).toBe("turn");
    expect(e.source).toBe("conversation");
    expect(e.text).toBe("the I-20 office is only open weekdays until 4");
    const raw = t.svc.db.get<{ text_enc: string }>("SELECT text_enc FROM entries WHERE id = ?", [u.id])!;
    expect(raw.text_enc).not.toContain("weekdays");
    t.svc.conversation.saveTurn({ convId: conv, role: "ava", mode: "async", text: "Noted." });
    expect(t.svc.conversation.turns(conv, 10).map((x) => x.role)).toEqual(["user", "ava"]);
    expect(t.svc.memory.count({ kind: "turn" })).toBe(2);
  });

  it("records item changes and card responses with what they touched", async () => {
    t = appAt();
    const it = t.svc.items.create({ type: "task", title: "Send the form" }, { source: "manual", via: "test" });
    const events = t.svc.memory.list({ kind: "item_event" });
    expect(events.length).toBeGreaterThan(0);
    const last = events.at(-1)!;
    expect(last.meta.item_id).toBe(it.id);
    expect(last.text).toContain("Send the form");
    expect(t.svc.memory.entriesFor("item", it.id)).toContain(last.id);

    const card = t.svc.cards.create({ kind: "do", source: "review", ref_id: it.id, title: "Send the form", why: null, options: [], priority: 10, item_ids: [it.id] });
    await t.svc.cards.respond(card.id, "not_now");
    const resp = t.svc.memory.list({ kind: "card_response" }).at(-1)!;
    expect(resp.text).toContain("not now");
    const links = t.svc.memory.linksOf(resp.id);
    expect(links.some((l) => l.rel === "about" && l.target_kind === "card" && l.target_id === card.id)).toBe(true);
    expect(links.some((l) => l.rel === "touched" && l.target_kind === "item" && l.target_id === it.id)).toBe(true);
  });

  it("forgetting leaves a content-free tombstone; nothing else deletes", () => {
    t = appAt();
    const a = t.svc.memory.append({ kind: "transcript", source: "test", text: "words to forget" });
    const b = t.svc.memory.append({ kind: "transcript", source: "test", text: "words to keep" });
    expect(t.svc.memory.forget([a], "deleted at my request on 2026-10-05")).toBe(1);
    const gone = t.svc.memory.get(a)!;
    expect(gone.text).toBe("");
    expect(gone.deleted_at).not.toBeNull();
    expect(gone.deleted_reason).toBe("deleted at my request on 2026-10-05");
    // The row itself stays — content-free but present.
    expect(t.svc.db.get("SELECT id FROM entries WHERE id = ?", [a])).toBeTruthy();
    expect(t.svc.memory.list({}).map((x) => x.id)).not.toContain(a);
    expect(t.svc.memory.list({ includeDeleted: true }).map((x) => x.id)).toContain(a);
    expect(t.svc.memory.get(b)!.text).toBe("words to keep");
    // Source-scoped forgetting (explicit source deletion) tombstones its entries.
    expect(t.svc.memory.forgetBySource("test", "you deleted the test source")).toBe(1);
    expect(t.svc.memory.get(b)!.deleted_at).not.toBeNull();
  });

  it("retention keeps his words and purges only raw samples", () => {
    t = appAt();
    const svc = t.svc;
    const past = new Date(t.clock.now().getTime() - 86_400_000).toISOString();
    const ins = "INSERT INTO evidence (id, kind, source, source_ref, occurred_at, created_at, summary_enc, content_enc, distilled_at, purge_after) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)";
    svc.db.run(ins, ["evd_words", "transcript", "voice", past, past, svc.cipher.encJson({ entry_id: "ent_x" }), past, past]);
    svc.db.run(ins, ["evd_raw", "activity_session", "activity", past, past, svc.cipher.encJson({ titles: ["VS Code"] }), past, past]);
    const purged = svc.evidence.purgeDue(t.clock.now());
    expect(purged).toBe(1);
    expect(svc.evidence.get("evd_words")!.content).toEqual({ entry_id: "ent_x" });
    expect(svc.evidence.get("evd_raw")!.content).toEqual({ purged: true });
  });

  it("backfills old turns and sourced text into the log, resumably and without duplication", async () => {
    t = appAt();
    const { db, cipher, memory } = t.svc;
    const past = atLocal("2026-09-01", "09:00", NY).toISOString();
    db.run("INSERT INTO turns (id, conversation_id, role, mode, text_enc, raw_enc, input_kind, operational, affirmation, trimmed, created_at) VALUES ('trn_a', 'c1', 'user', 'async', ?, NULL, 'dictated', 0, 0, 0, ?)", [cipher.encrypt("old words, kept verbatim"), past]);
    db.run("INSERT INTO turns (id, conversation_id, role, mode, text_enc, raw_enc, input_kind, operational, affirmation, trimmed, created_at) VALUES ('trn_b', 'c1', 'ava', 'async', ?, NULL, NULL, 0, 1, 0, ?)", [cipher.encrypt("old reply"), past]);
    const ins = "INSERT INTO evidence (id, kind, source, source_ref, occurred_at, created_at, summary_enc, content_enc, distilled_at, purge_after) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)";
    db.run(ins, ["evd_imp", "conversation_import", "chat_import", "chatgpt:abc", past, past, cipher.encJson({ title: "Old thread", platform: "chatgpt", created_at: past, updated_at: past, text: "my old chat words" }), null]);
    db.run(ins, ["evd_tr", "transcript", "voice", "trn_a", past, past, cipher.encJson("duplicated transcript text"), past]);

    expect(t.svc.backfill.step()).toBe(true); // one batch: the two old turns
    expect(t.svc.backfill.progress().copied.turns).toBe(2);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM turns")!.n).toBe(0);
    while (t.svc.backfill.step()) {
      /* resume through the remaining phases */
    }
    const done = t.svc.backfill.progress();
    expect(done.phase).toBe("done");
    expect(done.copied.evidence).toBe(1); // the import moved; the transcript row only re-pointed
    expect(memory.get("trn_a")!.text).toBe("old words, kept verbatim");
    expect(memory.get("trn_a")!.meta.mode).toBe("async");
    expect(memory.get("trn_b")!.meta.affirmation).toBe(true);
    expect(memory.list({ kind: "import" })[0].text).toBe("my old chat words");
    // The transcript row now points at its turn instead of carrying a second copy.
    expect(t.svc.evidence.get("evd_tr")!.content).toEqual({ entry_id: "trn_a" });
    // Re-running changes nothing.
    t.svc.backfill.runAll();
    expect(memory.list({ kind: "import" }).length).toBe(1);
    expect(memory.count({ kind: "turn" })).toBe(2);
  });

  it("copies item history up to the boot boundary as change events", () => {
    t = appAt();
    const it = t.svc.items.create({ type: "task", title: "Legacy task" }, { source: "manual", via: "test" });
    // Pretend this row predates the log (the boundary normally comes from boot).
    const row = t.svc.db.get<{ id: number }>("SELECT MAX(id) AS id FROM item_history")!;
    t.svc.memory.setState("backfill", {
      phase: "history",
      copied: { turns: 0, evidence: 0, history: 0 },
      skipped_purged: 0,
      errors: 0,
      cursor: { ev_at: "", ev_id: "", hist_id: 0, hist_max: row.id },
      started_at: t.clock.now().toISOString(),
      finished_at: null,
    });
    t.svc.backfill.runAll();
    const evs = t.svc.memory.list({ kind: "item_event" }).filter((e) => e.meta.history_id === row.id);
    expect(evs).toHaveLength(1);
    expect(evs[0].text).toContain("Legacy task");
    expect(t.svc.memory.entriesFor("item", it.id)).toContain(evs[0].id);
  });
});
