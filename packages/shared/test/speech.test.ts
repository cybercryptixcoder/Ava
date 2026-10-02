import { describe, expect, it } from "vitest";
import { alignWordTimings, charsToWords, cueTimes, parseScript, stripTokens, takeSentences } from "../src/speech";

describe("speech adaptation", () => {
  it("parses cue and tone tokens out of the script with correct offsets", () => {
    const p = parseScript("Three ways to start. [[opts]] I'd take [[opts.o1]] the first. [[tone:gentler]] No rush.");
    expect(p.text).toBe("Three ways to start. I'd take the first. No rush.");
    expect(p.cues.map((c) => c.target)).toEqual(["opts", "opts.o1"]);
    expect(p.text.slice(p.cues[0].at).startsWith("I'd take")).toBe(true);
    expect(p.text.slice(p.cues[1].at).startsWith("the first")).toBe(true);
    expect(p.tones).toEqual([{ tone: "gentler", at: p.text.indexOf("No rush") }]);
  });

  it("ignores unknown tones and keeps display text clean", () => {
    expect(parseScript("Hi [[tone:shouty]] there").tones).toEqual([]);
    expect(stripTokens("Look [[plan]] here.")).toBe("Look here.");
  });

  it("maps character alignment to words and cues to times", () => {
    const text = "Do the quiz";
    const chars = text.split("");
    const starts = chars.map((_, i) => i * 50);
    const ends = chars.map((_, i) => i * 50 + 40);
    const words = charsToWords(chars, starts, ends);
    expect(words.map((w) => w.word)).toEqual(["Do", "the", "quiz"]);
    expect(words[2].start_ms).toBe(7 * 50);
    const aligned = alignWordTimings(text, words);
    const times = cueTimes([{ target: "quiz", at: text.indexOf("quiz") }], aligned);
    expect(times).toEqual([{ target: "quiz", at_ms: 350 }]);
  });

  it("cuts complete sentences for streaming TTS, but not on abbreviations", () => {
    const [done, rest] = takeSentences("Start with problems, e.g. the Bellman-Ford pair. Then the MST one. And th");
    expect(done).toEqual(["Start with problems, e.g. the Bellman-Ford pair.", "Then the MST one."]);
    expect(rest).toBe("And th");
  });
});
