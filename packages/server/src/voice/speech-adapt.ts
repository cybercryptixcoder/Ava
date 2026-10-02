import { parseScript, type Cue, type Tone, type ToneMark } from "@ava/shared";

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const ORD: Record<string, string> = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON_ABBR: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

export function numberToWords(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `minus ${numberToWords(-n)}`;
  if (!Number.isInteger(n)) {
    const [i, d] = String(n).split(".");
    return `${numberToWords(Number(i))} point ${d.split("").map((x) => ONES[Number(x)]).join(" ")}`;
  }
  if (n < 20) return ONES[n];
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ""}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberToWords(n % 100)}` : ""}`;
  if (n < 1_000_000) return `${numberToWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberToWords(n % 1000)}` : ""}`;
  if (n < 1_000_000_000) return `${numberToWords(Math.floor(n / 1_000_000))} million${n % 1_000_000 ? ` ${numberToWords(n % 1_000_000)}` : ""}`;
  return String(n);
}

export function ordinalWords(n: number): string {
  const w = numberToWords(n);
  const parts = w.split(/([ -])/);
  const last = parts[parts.length - 1];
  const ord = ORD[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  parts[parts.length - 1] = ord;
  return parts.join("");
}

/** "1:20" -> "one twenty", "9:05 am" -> "nine oh five a.m.", "14:00" -> "two p.m." */
function clockWords(h: number, m: number, suffix?: string): string {
  let ampm = suffix?.toLowerCase().replace(/\./g, "");
  let hour = h;
  if (!ampm && h >= 13) {
    hour = h - 12;
    ampm = "pm";
  } else if (!ampm && h === 0) {
    hour = 12;
    ampm = "am";
  } else if (!ampm && h === 12 && m === 0) return "noon";
  if (hour > 12) hour -= 12;
  if (hour === 0) hour = 12;
  const mins = m === 0 ? (ampm ? "" : " o'clock") : m < 10 ? ` oh ${ONES[m]}` : ` ${numberToWords(m)}`;
  return `${numberToWords(hour)}${mins}${ampm ? ` ${ampm === "am" ? "a.m." : "p.m."}` : ""}`.trim();
}

/** Course codes are read as people say them: "465" -> "four sixty-five". */
function courseNumberWords(num: string): string {
  if (num.length === 3) {
    const a = Number(num[0]);
    const rest = Number(num.slice(1));
    return `${ONES[a]} ${rest === 0 ? "hundred" : rest < 10 ? `oh ${ONES[rest]}` : numberToWords(rest)}`;
  }
  return numberToWords(Number(num));
}

/** Plain-text adaptation of one segment (no control tokens inside). */
export function adaptSegment(text: string, lexicon: { text: string; say: string }[] = []): string {
  let t = text;
  for (const { text: from, say } of lexicon) {
    if (!from) continue;
    t = t.replace(new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), say);
  }
  t = t
    // markdown and list markers
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,!?]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "the link on screen")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    // abbreviations
    .replace(/\be\.g\./gi, "for example")
    .replace(/\bi\.e\./gi, "that is")
    .replace(/\bvs\.?\b/gi, "versus")
    .replace(/\betc\./gi, "and so on")
    .replace(/\bw\//gi, "with ")
    .replace(/\s&\s/g, " and ")
    .replace(/\s?->\s?|→/g, " to ")
    .replace(/—|–/g, ", ")
    // ISO dates and "Oct 3" style
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_m, _y, mo, d) => `${MONTHS[Number(mo) - 1]} ${ordinalWords(Number(d))}`)
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(st|nd|rd|th)?\b/gi, (_m, mon: string, d: string) => `${MONTHS[MON_ABBR[mon.toLowerCase()]]} ${ordinalWords(Number(d))}`)
    // times
    .replace(/\b(\d{1,2}):(\d{2})\s*(am|pm|a\.m\.|p\.m\.)?/gi, (_m, h: string, mm: string, s?: string) => clockWords(Number(h), Number(mm), s))
    .replace(/\b(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)/gi, (_m, h: string, s: string) => clockWords(Number(h), 0, s))
    // course codes like CMPSC 465
    .replace(/\b([A-Z]{2,6})\s?(\d{3})\b/g, (_m, code: string, num: string) => `${code} ${courseNumberWords(num)}`)
    // money, percent, ordinals, ranges, plain numbers
    .replace(/\$(\d+(?:\.\d+)?)/g, (_m, n: string) => `${numberToWords(Number(n))} dollars`)
    .replace(/₹\s?(\d+(?:,\d{3})*)/g, (_m, n: string) => `${numberToWords(Number(n.replace(/,/g, "")))} rupees`)
    .replace(/(\d+(?:\.\d+)?)\s?%/g, (_m, n: string) => `${numberToWords(Number(n))} percent`)
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, (_m, n: string) => ordinalWords(Number(n)))
    .replace(/\b(\d+)\s?[-–]\s?(\d+)\b/g, (_m, a: string, b: string) => `${numberToWords(Number(a))} to ${numberToWords(Number(b))}`)
    .replace(/\b\d{1,3}(,\d{3})+\b/g, (m) => numberToWords(Number(m.replace(/,/g, ""))))
    .replace(/\b\d+(\.\d+)?\b/g, (m) => numberToWords(Number(m)))
    .replace(/[()[\]{}]/g, "")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/[ \t]+/g, " ");
  return t;
}

/** Lines that look like list items. Lists go on screen, never into speech. */
const LIST_LINE = /^\s*([-*•]|\d+[.)])\s+/;

export interface SpeechPlan {
  /** Text sent to TTS. */
  text: string;
  /** Cue positions in `text` coordinates. */
  cues: Cue[];
  tones: ToneMark[];
  droppedListLines: number;
}

/**
 * Prepare Ava's words for speech. Control tokens are removed, but their
 * positions are carried into the adapted text so word timestamps can drive
 * the canvas.
 */
export function planSpeech(raw: string, opts: { lexicon?: { text: string; say: string }[]; allowedTones?: Tone[] } = {}): SpeechPlan {
  let dropped = 0;
  const withoutLists = raw
    .split(/\r?\n/)
    .filter((l) => {
      if (LIST_LINE.test(l)) {
        dropped++;
        return false;
      }
      return true;
    })
    .join("\n");
  const parsed = parseScript(withoutLists);
  const marks = [...parsed.cues.map((c) => ({ at: c.at, cue: c })), ...parsed.tones.map((t) => ({ at: t.at, tone: t }))].sort((a, b) => a.at - b.at);
  let out = "";
  let last = 0;
  const cues: Cue[] = [];
  const tones: ToneMark[] = [];
  for (const m of marks) {
    out += adaptSegment(parsed.text.slice(last, m.at), opts.lexicon);
    last = m.at;
    if ("cue" in m && m.cue) cues.push({ target: m.cue.target, at: out.length });
    if ("tone" in m && m.tone && (!opts.allowedTones || opts.allowedTones.includes(m.tone.tone))) tones.push({ tone: m.tone.tone, at: out.length });
  }
  out += adaptSegment(parsed.text.slice(last), opts.lexicon);
  // Keep at most one tone shift per reply: constant emotional markup sounds performed.
  return { text: out.trimEnd(), cues, tones: tones.slice(0, 1), droppedListLines: dropped };
}
