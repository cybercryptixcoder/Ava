import { describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { detectAffirmations, enforceAffirmationBudget } from "../src/conversation/affirmation";
import { dropTrimmedSentences } from "../src/conversation/conversation";
import { DirectiveParser, type Directive } from "../src/conversation/directives";
import { parseChatExport, userTextOf } from "../src/sources/parsers/chat-export";
import { parseSavedFile } from "../src/sources/parsers/saved-items";
import { soundsUnfinished, TurnDetector, type TurnSignal } from "../src/voice/turn-detector";
import { Cipher, hashPassword, verifyPassword } from "../src/security/crypto";

describe("affirmation budget", () => {
  it("detects praise but not agreement on substance", () => {
    expect(detectAffirmations("Great question. The quiz is Thursday.")).toHaveLength(1);
    expect(detectAffirmations("You're right that the quiz is Thursday.")).toHaveLength(0);
    expect(detectAffirmations("Nice work getting the parser going.")).toHaveLength(1);
  });

  it("allows one in the window, trims the next, regenerates when nothing would be left", () => {
    expect(enforceAffirmationBudget("Good call. Quiz first.", { recentCount: 0, max: 1, operational: false, completionAck: false }).action).toBe("keep");
    const trim = enforceAffirmationBudget("Good call. Quiz first.", { recentCount: 1, max: 1, operational: false, completionAck: false });
    expect(trim).toMatchObject({ action: "trim", text: "Quiz first." });
    expect(enforceAffirmationBudget("Love it!", { recentCount: 1, max: 1, operational: false, completionAck: false }).action).toBe("regenerate");
  });

  it("allows none in operational messages unless acknowledging a real completion", () => {
    expect(enforceAffirmationBudget("Nice work. Quiz 4 is off the list.", { recentCount: 0, max: 1, operational: true, completionAck: false }).action).toBe("trim");
    expect(enforceAffirmationBudget("Nice work. Quiz 4 is off the list.", { recentCount: 0, max: 1, operational: true, completionAck: true }).action).toBe("keep");
  });

  it("removes trimmed sentences from the raw reply around directives", () => {
    const raw = 'Love that idea. <show>{"key":"n"}</show> The essay comes after.';
    expect(dropTrimmedSentences(raw, "Love that idea. The essay comes after.", "The essay comes after.")).toBe('<show>{"key":"n"}</show> The essay comes after.');
  });
});

describe("directive parser", () => {
  it("passes words through as they stream and emits directives once closed", () => {
    const text: string[] = [];
    const dirs: Directive[] = [];
    const p = new DirectiveParser((t) => text.push(t), (d) => dirs.push(d));
    for (const chunk of ['Three ways. <sh', 'ow>{"key":"o"', '}</show> I\'d take [[o.o1]] the first. <remove key="old"/>']) p.push(chunk);
    p.end();
    expect(p.text.replace(/\s+/g, " ").trim()).toBe("Three ways. I'd take [[o.o1]] the first.");
    expect(dirs.map((d) => d.kind)).toEqual(["show", "remove"]);
  });
});

describe("chat export import", () => {
  it("reads ChatGPT and Claude exports, keeping only his side for extraction", () => {
    const chatgpt = [
      {
        title: "Robotics",
        create_time: 1727000000,
        current_node: "c",
        mapping: {
          a: { message: null, parent: null, children: ["b"] },
          b: { message: { author: { role: "user" }, content: { parts: ["How do I tune PID gains?"] }, create_time: 1727000001 }, parent: "a", children: ["c"] },
          c: { message: { author: { role: "assistant" }, content: { parts: ["Start with P."] }, create_time: 1727000002 }, parent: "b", children: [] },
        },
      },
    ];
    const claude = [{ uuid: "x", name: "SOP", created_at: "2026-09-01T10:00:00Z", chat_messages: [{ sender: "human", text: "Help me tighten my SOP", created_at: "2026-09-01T10:00:00Z" }, { sender: "assistant", text: "Sure." }] }];
    const zip = zipSync({ "conversations.json": strToU8(JSON.stringify(chatgpt)) });
    const a = parseChatExport(Buffer.from(zip), "export.zip");
    expect(a.conversations).toHaveLength(1);
    expect(a.conversations[0].messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(userTextOf(a.conversations[0])).toContain("PID gains");
    expect(userTextOf(a.conversations[0])).not.toContain("Start with P");
    const b = parseChatExport(Buffer.from(JSON.stringify(claude)), "conversations.json");
    expect(b.conversations[0].title).toBe("SOP");
  });

  it("tolerates junk without throwing", () => {
    expect(() => parseChatExport(Buffer.from("not json"), "conversations.json")).not.toThrow();
  });

  it("keeps user text when content lives in mixed parts, content.text or empty arrays", () => {
    const nodes = {
      a: { message: null, parent: null, children: ["b"] },
      // Mixed parts: the string is his, the image pointer is skipped, nothing crashes.
      b: {
        message: {
          author: { role: "user" },
          content: { content_type: "multimodal_text", parts: ["Design review tomorrow at 3?", { content_type: "image_asset_pointer", asset_pointer: "file-service://file-abc123" }] },
          create_time: 1727000001,
        },
        parent: "a",
        children: ["c"],
      },
      // Text in content.text on a code message.
      c: {
        message: { author: { role: "assistant" }, content: { content_type: "code", text: "def shift(t, n): return t[n:] + t[:n]" }, create_time: 1727000002 },
        parent: "b",
        children: ["d"],
      },
      // An execution output carries its text in content.text too.
      d: {
        message: { author: { role: "assistant" }, content: { content_type: "execution_output", text: "3 tests passed" }, create_time: 1727000003 },
        parent: "c",
        children: ["e"],
      },
      // Empty parts, and parts of empty strings, contribute nothing and crash nothing.
      e: {
        message: { author: { role: "user" }, content: { content_type: "text", parts: [] }, create_time: 1727000004 },
        parent: "d",
        children: ["f"],
      },
      f: {
        message: { author: { role: "user" }, content: { content_type: "text", parts: ["", "  ", "Also, book the room"] }, create_time: 1727000005 },
        parent: "e",
        children: [],
      },
    };
    const data = [{ title: "Mixed", create_time: 1727000000, current_node: "f", mapping: nodes }];
    const r = parseChatExport(Buffer.from(JSON.stringify(data)), "conversations.json");
    expect(r.conversations).toHaveLength(1);
    const msgs = r.conversations[0].messages;
    expect(msgs.map((m) => m.text)).toEqual([
      "Design review tomorrow at 3?",
      "def shift(t, n): return t[n:] + t[:n]",
      "3 tests passed",
      "Also, book the room",
    ]);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "user"]);
    // His side for extraction still finds the two things he said, and nothing of the model's.
    const mine = userTextOf(r.conversations[0]);
    expect(mine).toContain("Design review tomorrow at 3?");
    expect(mine).toContain("Also, book the room");
    expect(mine).not.toContain("tests passed");
  });
});

describe("saved items import", () => {
  it("reads Netscape bookmark HTML and generic CSVs", () => {
    const html = `<DL><p><DT><A HREF="https://example.com/a" ADD_DATE="1727000000">Paper A</A><DT><A HREF="https://example.com/b">Talk B</A></DL>`;
    const r = parseSavedFile(Buffer.from(html), "bookmarks.html");
    expect(r.entries.map((e) => e.title)).toEqual(["Paper A", "Talk B"]);
    const csv = parseSavedFile(Buffer.from('title,url\n"Video, part 1",https://youtu.be/x\n'), "watch-later.csv");
    expect(csv.entries[0]).toMatchObject({ title: "Video, part 1", url: "https://youtu.be/x" });
  });
});

describe("turn detection for someone who thinks out loud", () => {
  it("hears unfinished endings", () => {
    expect(soundsUnfinished("so the thing is, and")).toBe(true);
    expect(soundsUnfinished("I think we should, um")).toBe(true);
    expect(soundsUnfinished("Let's do the quiz first.")).toBe(false);
  });

  it("holds the turn open through an unfinished ending and joins the continuation", () => {
    vi.useFakeTimers();
    const out: TurnSignal[] = [];
    const d = new TurnDetector(0.65, (s) => out.push(s));
    d.handle({ type: "eot", text: "so first the quiz and", confidence: 0.8, audio_end_s: 3, trigger: "eot" });
    expect(out.some((s) => s.type === "end")).toBe(false);
    d.handle({ type: "speech_start" });
    d.handle({ type: "eot", text: "then the essay.", confidence: 0.9, audio_end_s: 6, trigger: "eot" });
    const end = out.find((s) => s.type === "end") as Extract<TurnSignal, { type: "end" }>;
    expect(end.text).toBe("so first the quiz and then the essay.");
    // An unfinished ending with silence afterwards still ends after the grace window.
    d.handle({ type: "eot", text: "and maybe", confidence: 0.7, audio_end_s: 9, trigger: "eot" });
    vi.advanceTimersByTime(5000);
    expect(out.filter((s) => s.type === "end")).toHaveLength(2);
    vi.useRealTimers();
  });
});

describe("encryption at rest and passwords", () => {
  it("round-trips fields and files and rejects tampering", () => {
    const c = new Cipher("a".repeat(64));
    const enc = c.encrypt("Send Riya the slides");
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toContain("Riya");
    expect(c.decrypt(enc)).toBe("Send Riya the slides");
    const bytes = Buffer.from(enc.slice(3), "base64");
    bytes[bytes.length - 5] ^= 1;
    const tampered = `v1:${bytes.toString("base64")}`;
    expect(() => c.decrypt(tampered)).toThrow();
    const buf = c.encryptBuffer(Buffer.from("audio"));
    expect(c.decryptBuffer(buf).toString()).toBe("audio");
    expect(() => new Cipher("b".repeat(64)).decrypt(enc)).toThrow();
  });

  it("hashes passwords with a salt", () => {
    const h = hashPassword("correct horse");
    expect(h).not.toContain("correct");
    expect(verifyPassword("correct horse", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
    expect(hashPassword("correct horse")).not.toBe(h);
  });
});

describe("retention", () => {
  it("deletes raw window titles even when they were never labeled", async () => {
    const { makeApp, hours } = await import("./helpers");
    const { runRetention } = await import("../src/core/retention");
    const t = makeApp();
    try {
      t.svc.sources.activity.ingest({ device: "laptop", sessions: [{ app: "Code", title: "secret.c", started_at: "2026-10-05T13:00:00Z", ended_at: "2026-10-05T13:30:00Z", active_seconds: 1700 }] });
      const has = () => !!t.svc.db.get<{ title_enc: string | null }>("SELECT title_enc FROM activity_sessions")!.title_enc;
      runRetention(t.svc);
      expect(has()).toBe(true);
      t.clock.advance(hours(24 * 7));
      runRetention(t.svc);
      expect(has()).toBe(false);
    } finally {
      t.close();
    }
  });
});
