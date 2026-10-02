/**
 * Affirmation and praise detection. The conversational model is never told
 * to encourage; this post-check enforces a budget instead (default: at most
 * one affirmation per ten exchanges, none in operational messages unless
 * acknowledging a real completion).
 */
const PATTERNS: RegExp[] = [
  /\b(great|good|excellent|fantastic|amazing|awesome|brilliant|wonderful|fascinating|interesting) (question|point|idea|thought|call|catch|instinct|move|insight|observation|work|job|progress|thinking)\b/i,
  /\b(love|loving) (that|this|it|how|the way)\b/i,
  /\bthat'?s (a |an |such a |really |so )?(great|good|excellent|fantastic|amazing|awesome|brilliant|wonderful|smart|clever|lovely|impressive|beautiful)\b/i,
  /\bwhat a (great|good|smart|clever|fantastic|lovely|brilliant)\b/i,
  /\b(well done|nice work|nice job|good job|great job|nice one|good on you|way to go|keep it up|kudos|bravo|nailed it|you nailed|crushed it|killing it|proud of you|so proud)\b/i,
  /\byou('ve| have)? got this\b/i,
  /\byou('re| are) (doing )?(great|amazing|awesome|fantastic|brilliant|so smart|a genius|on fire|crushing it)\b/i,
  /\b(impressive|genius|spot on)\b/i,
  /^(great|awesome|amazing|perfect|excellent|fantastic|love it|nice|exactly right|absolutely right|exactly)[!.,]/i,
];

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+(?=[A-Z"'(\[])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Returns the matched praise phrases (empty if none). */
export function detectAffirmations(text: string): string[] {
  const out: string[] = [];
  for (const s of splitSentences(text)) {
    for (const p of PATTERNS) {
      const m = p.exec(s);
      if (m) {
        out.push(m[0]);
        break;
      }
    }
  }
  return out;
}

/** Sentence indices that contain praise. */
export function affirmingSentences(text: string): number[] {
  return splitSentences(text)
    .map((s, i) => (PATTERNS.some((p) => p.test(s)) ? i : -1))
    .filter((i) => i >= 0);
}

/** Remove the given sentences, keeping the rest intact. Preserves canvas directives and cue tokens. */
export function trimSentences(text: string, indices: number[]): string {
  if (!indices.length) return text;
  const drop = new Set(indices);
  return splitSentences(text)
    .filter((_s, i) => !drop.has(i))
    .join(" ")
    .trim();
}

export interface AffirmationDecision {
  found: string[];
  allowed: boolean;
  action: "keep" | "trim" | "regenerate";
  text: string;
}

/**
 * Apply the budget. `recentCount` is the number of affirmations in the last
 * `window` assistant replies.
 */
export function enforceAffirmationBudget(
  text: string,
  opts: { recentCount: number; max: number; operational: boolean; completionAck: boolean; extraSentences?: number[] },
): AffirmationDecision {
  const idx = Array.from(new Set([...affirmingSentences(text), ...(opts.extraSentences ?? [])])).sort((a, b) => a - b);
  const sentences = splitSentences(text);
  const found = idx.map((i) => sentences[i]).filter(Boolean);
  if (!found.length) return { found, allowed: true, action: "keep", text };
  const allowed = opts.operational ? opts.completionAck && found.length === 1 : opts.recentCount + 1 <= opts.max && found.length === 1;
  if (allowed) return { found, allowed, action: "keep", text };
  const trimmed = trimSentences(text, idx);
  if (trimmed.replace(/<[^>]+>|\[\[[^\]]+\]\]/g, "").trim().length < 8) return { found, allowed: false, action: "regenerate", text };
  return { found, allowed: false, action: "trim", text: trimmed };
}
