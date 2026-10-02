import type { SttEvent } from "./stt/types";
import { patienceParams } from "./stt/types";

/** Words that, at the end of a stretch of speech, mean the thought isn't finished. */
const TRAILING = new Set([
  "and",
  "but",
  "so",
  "because",
  "cause",
  "like",
  "um",
  "uh",
  "uhm",
  "er",
  "the",
  "a",
  "an",
  "to",
  "of",
  "with",
  "or",
  "if",
  "then",
  "which",
  "that",
  "where",
  "when",
  "while",
  "for",
  "my",
  "your",
  "is",
  "was",
  "i",
  "i'm",
  "we",
  "it's",
  "also",
  "maybe",
  "basically",
  "actually",
  "means",
]);

export function soundsUnfinished(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (/[,;:—-]$/.test(t)) return true;
  if (/(\.\.\.|…)$/.test(t)) return true;
  const last = t.replace(/[.!?]+$/, "").split(/\s+/).pop() ?? "";
  if (TRAILING.has(last.replace(/[^a-z']/g, ""))) return true;
  return false;
}

export type TurnSignal =
  | { type: "speech_start" }
  | { type: "partial"; text: string }
  | { type: "eager"; text: string }
  | { type: "resumed" }
  | { type: "end"; text: string; detected_at: number; audio_end_s: number | null; held_ms: number };

/**
 * Semantic turn detection for someone who thinks out loud. The provider's
 * end-of-turn model decides first (tuned by the patience setting); on top of
 * that, an ending that sounds unfinished ("…and", "so the") holds the turn
 * open for a grace period, and any new speech in that window joins the same
 * turn. Ava only starts speaking when the thought is actually done.
 */
export class TurnDetector {
  private parts: string[] = [];
  private grace: NodeJS.Timeout | null = null;
  private holdStarted = 0;
  private lastAudioEnd: number | null = null;

  constructor(
    private patience: number,
    private emit: (s: TurnSignal) => void,
    private now: () => number = () => Date.now(),
  ) {}

  setPatience(p: number) {
    this.patience = p;
  }

  private text(extra?: string): string {
    return [...this.parts, ...(extra ? [extra] : [])].join(" ").replace(/\s+/g, " ").trim();
  }

  handle(e: SttEvent): void {
    switch (e.type) {
      case "speech_start":
        if (this.grace) {
          // Speech resumed inside the grace window: same thought continues.
          clearTimeout(this.grace);
          this.grace = null;
          this.emit({ type: "resumed" });
        } else this.emit({ type: "speech_start" });
        break;
      case "partial":
        if (this.grace) {
          clearTimeout(this.grace);
          this.grace = null;
          this.emit({ type: "resumed" });
        }
        this.emit({ type: "partial", text: this.text(e.text) });
        break;
      case "eager_eot":
        if (!soundsUnfinished(e.text)) this.emit({ type: "eager", text: this.text(e.text) });
        break;
      case "resumed":
        this.emit({ type: "resumed" });
        break;
      case "eot": {
        if (!e.text.trim()) return;
        this.parts.push(e.text.trim());
        this.lastAudioEnd = e.audio_end_s;
        const forced = e.trigger === "timeout" || e.trigger === "manual";
        if (!forced && soundsUnfinished(e.text) && this.patience > 0.15) {
          const ms = patienceParams(this.patience).trailing_grace_ms;
          this.holdStarted = this.now();
          this.grace = setTimeout(() => this.finish(), ms);
          return;
        }
        this.finish();
        break;
      }
      default:
        break;
    }
  }

  private finish(): void {
    this.grace = null;
    const text = this.text();
    this.parts = [];
    if (!text) return;
    const held = this.holdStarted ? this.now() - this.holdStarted : 0;
    this.holdStarted = 0;
    this.emit({ type: "end", text, detected_at: this.now(), audio_end_s: this.lastAudioEnd, held_ms: held });
  }

  reset(): void {
    if (this.grace) clearTimeout(this.grace);
    this.grace = null;
    this.parts = [];
  }
}
