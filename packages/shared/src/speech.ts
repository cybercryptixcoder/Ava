/**
 * Control tokens inside Ava's spoken text.
 *
 *   [[opts]]          reveal module "opts" (or its first segment) here
 *   [[opts.b]]        reveal segment "b" of module "opts" here
 *   [[tone:gentler]]  speak the next sentence a little gentler
 *
 * Tokens never reach the screen or the text-to-speech provider. Their
 * character positions are carried through speech adaptation so word-level
 * timestamps from TTS can tell the app when to reveal each segment.
 */

export const TONES = ["gentler", "lighter", "serious", "warmer", "brisk"] as const;
export type Tone = (typeof TONES)[number];

export interface Cue {
  target: string;
  /** Character offset in the clean text where the cue sits. */
  at: number;
}

export interface ToneMark {
  tone: Tone;
  at: number;
}

export interface ParsedScript {
  text: string;
  cues: Cue[];
  tones: ToneMark[];
}

const TOKEN = /\[\[([^\]]{1,60})\]\]/g;

export function parseScript(raw: string): ParsedScript {
  const cues: Cue[] = [];
  const tones: ToneMark[] = [];
  let text = "";
  let last = 0;
  for (const m of raw.matchAll(TOKEN)) {
    text += raw.slice(last, m.index);
    last = m.index! + m[0].length;
    const body = m[1].trim();
    if (body.startsWith("tone:")) {
      const tone = body.slice(5).trim() as Tone;
      if ((TONES as readonly string[]).includes(tone)) tones.push({ tone, at: text.length });
    } else if (/^[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)?$/i.test(body)) {
      cues.push({ target: body, at: text.length });
    }
  }
  text += raw.slice(last);
  // Collapse doubled spaces left behind by removed tokens, keeping offsets valid.
  const collapsed = collapseSpaces(text, [...cues, ...tones]);
  return { text: collapsed.text, cues, tones };
}

function collapseSpaces(text: string, marks: { at: number }[]): { text: string } {
  let out = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    map[i] = out.length;
    if (text[i] === " " && out.endsWith(" ")) continue;
    out += text[i];
  }
  map[text.length] = out.length;
  for (const m of marks) m.at = map[Math.min(m.at, text.length)];
  return { text: out };
}

/** Remove control tokens only (for display). */
export function stripTokens(raw: string): string {
  return parseScript(raw).text.trim();
}

export interface WordTiming {
  word: string;
  start_ms: number;
  end_ms: number;
  /** Char offset of the word in the TTS text, when the provider gives char alignment. */
  char_start?: number;
}

/** Locate each whitespace-delimited word of `text` with its char offset. */
export function wordsWithOffsets(text: string): { word: string; start: number }[] {
  const out: { word: string; start: number }[] = [];
  const re = /\S+/g;
  for (const m of text.matchAll(re)) out.push({ word: m[0], start: m.index! });
  return out;
}

function norm(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

/**
 * Give each word timing a char offset in `text` by walking both sequences.
 * Providers sometimes split or merge tokens; we match greedily on normalized
 * text and fall back to sequential assignment.
 */
export function alignWordTimings(text: string, timings: WordTiming[]): WordTiming[] {
  const words = wordsWithOffsets(text);
  let wi = 0;
  return timings.map((t) => {
    if (t.char_start !== undefined) return t;
    const target = norm(t.word);
    for (let k = wi; k < Math.min(words.length, wi + 4); k++) {
      if (norm(words[k].word) === target || norm(words[k].word).startsWith(target) || target.startsWith(norm(words[k].word))) {
        wi = k + 1;
        return { ...t, char_start: words[k].start };
      }
    }
    const w = words[Math.min(wi, words.length - 1)];
    wi++;
    return { ...t, char_start: w ? w.start : 0 };
  });
}

/** Convert per-character alignment (ElevenLabs style) into word timings. */
export function charsToWords(chars: string[], startsMs: number[], endsMs: number[], offset = 0): WordTiming[] {
  const words: WordTiming[] = [];
  let cur: WordTiming | null = null;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (/\s/.test(c)) {
      if (cur) words.push(cur);
      cur = null;
      continue;
    }
    if (!cur) cur = { word: c, start_ms: startsMs[i], end_ms: endsMs[i], char_start: offset + i };
    else {
      cur.word += c;
      cur.end_ms = endsMs[i];
    }
  }
  if (cur) words.push(cur);
  return words;
}

/** Time (ms from audio start) at which each cue should fire. */
export function cueTimes(cues: Cue[], timings: WordTiming[]): { target: string; at_ms: number }[] {
  const sorted = [...timings].filter((t) => t.char_start !== undefined).sort((a, b) => a.char_start! - b.char_start!);
  return cues.map((c) => {
    const next = sorted.find((t) => t.char_start! >= c.at);
    if (next) return { target: c.target, at_ms: Math.max(0, Math.round(next.start_ms)) };
    const lastWord = sorted[sorted.length - 1];
    return { target: c.target, at_ms: lastWord ? Math.round(lastWord.end_ms) : 0 };
  });
}

/** Split text into sentences for streaming TTS. Returns [complete sentences, remainder]. */
export function takeSentences(buffer: string, minChars = 12): [string[], string] {
  const out: string[] = [];
  let rest = buffer;
  const re = /([.!?…]+["')\]]*)(\s+)/g;
  let lastCut = 0;
  for (const m of buffer.matchAll(re)) {
    const end = m.index! + m[1].length;
    const candidate = buffer.slice(lastCut, end).trim();
    // Don't split on abbreviations or decimals like "e.g." or "3.5".
    if (/\b(e\.g|i\.e|vs|etc|mr|ms|dr|st)\.$/i.test(candidate)) continue;
    if (candidate.length < minChars && out.length === 0 && lastCut === 0) continue;
    out.push(candidate);
    lastCut = end + m[2].length;
  }
  rest = buffer.slice(lastCut);
  return [out, rest];
}
