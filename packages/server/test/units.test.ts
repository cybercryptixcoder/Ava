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
