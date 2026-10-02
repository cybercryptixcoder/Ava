import { DateTime } from "luxon";
import { OptionActionSchema, formatClock, relativePhrase, statusLabel, type Item, type OptionAction } from "@ava/shared";
import type { Candidate } from "../rules/candidates";
import { detectAffirmations } from "../conversation/affirmation";

/**
 * A message as drafted (by the model or the fallback template). Facts are
 * placeholders: {{item:<id>.<field>}} or {{fact:<name>}}. The system renders
 * them from stored state, so the "because" line cannot contain a fact that
 * isn't true right now.
 */
export interface MessageDraft {
  rule_id: string;
  headline: string;
  because: string;
  cited_item_ids: string[];
  options: { key: string; label: string; action: OptionAction }[];
  urgency: "now" | "today" | "brief";
}

export interface ValidationContext {
  now: Date;
  tz: string;
  getItem: (id: string) => Item | null;
  projectTitle: (id: string) => string | null;
  ruleAllowsMessaging: (ruleId: string) => boolean;
  candidate: Candidate;
  recentlySent: (dedupeKey: string) => boolean;
  /** Operational messages may acknowledge a real completion and nothing else. */
  allowCompletionAck: boolean;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  rendered: { headline: string; because: string } | null;
}

export const ITEM_FIELDS = [
  "title",
  "due",
  "due_date",
  "status",
  "days_in_status",
  "days_since_touched",
  "start",
  "end",
  "estimate",
  "project",
  "person",
  "course",
  "kind",
] as const;

const PLACEHOLDER = /\{\{\s*(item|fact):([a-z0-9_]+)(?:\.([a-z_]+))?\s*\}\}/gi;

/** Attributions of feelings or states of mind. Never allowed without evidence, and messages carry none. */
export const STATE_OF_MIND =
  /\b(stress(ed|ful)?|anxious|anxiety|overwhelm(ed|ing)?|tired|exhausted|burn(ed|t)[ -]?out|frustrat(ed|ing)|worried|nervous|sad|lonely|unmotivated|motivated|procrastinat\w*|avoid(ing|ance)|lazy|distracted|struggl(e|ing)|panick?(ed|ing)?|scared|upset|bored|guilty|you seem|you feel|you're feeling|you are feeling|sounds like you|i can tell|feeling (down|low|off))\b/i;

/** Words that make factual claims about timing or status; those must come from placeholders. */
const CLAIM_WORDS =
  /\b(today|tonight|tomorrow|yesterday|morning|afternoon|evening|noon|midnight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december|week|weeks|hour|hours|minute|minutes|day|days|overdue|late|behind|missed|never|always|already|still|haven't|hasn't|not started|started|finished|completed|drafted|almost|untouched|stale|ignored|skipped|forgot|forgotten|again|last time)\b/i;

function renderField(item: Item, field: string, ctx: ValidationContext): string | null {
  const d = item.data as Record<string, unknown>;
  switch (field) {
    case "title":
      return item.title;
    case "due":
      return item.due_at ? relativePhrase(ctx.now, item.due_at, ctx.tz) : null;
    case "due_date":
      return item.due_at ? DateTime.fromISO(item.due_at).setZone(ctx.tz).toFormat("ccc d LLL") : null;
    case "status":
      return statusLabel(item.status).toLowerCase();
    case "days_in_status": {
      const n = Math.floor((ctx.now.getTime() - new Date(item.status_changed_at).getTime()) / 86_400_000);
      return `${n} day${n === 1 ? "" : "s"}`;
    }
    case "days_since_touched": {
      const n = Math.floor((ctx.now.getTime() - new Date(item.touched_at).getTime()) / 86_400_000);
      return `${n} day${n === 1 ? "" : "s"}`;
    }
    case "start":
      return item.start_at ? formatClock(item.start_at, ctx.tz) : null;
    case "end":
      return item.end_at ? formatClock(item.end_at, ctx.tz) : null;
    case "estimate":
      return typeof d.estimate_minutes === "number" ? `${d.estimate_minutes} minutes` : null;
    case "project":
      return item.project_id ? ctx.projectTitle(item.project_id) : null;
    case "person":
      return (d.to_person as string) ?? (d.counterpart as string) ?? null;
    case "course":
      return (d.course as string) ?? null;
    case "kind":
      return (d.kind as string) ?? null;
    default:
      return null;
  }
}

function render(text: string, cited: Set<string>, ctx: ValidationContext, errors: string[], where: string): { out: string; used: Set<string>; count: number } {
  const used = new Set<string>();
  let count = 0;
  const out = text.replace(PLACEHOLDER, (_m, ns: string, name: string, field?: string) => {
    count++;
    if (ns.toLowerCase() === "fact") {
      const v = ctx.candidate.facts[name];
      if (v === undefined) {
        errors.push(`${where}: unknown fact "${name}"`);
        return "";
      }
      return v;
    }
    if (!cited.has(name)) {
      errors.push(`${where}: placeholder cites ${name}, which is not in the cited items`);
      return "";
    }
    const item = ctx.getItem(name);
    if (!item) {
      errors.push(`${where}: item ${name} does not exist`);
      return "";
    }
    const f = field ?? "title";
    if (!(ITEM_FIELDS as readonly string[]).includes(f)) {
      errors.push(`${where}: field "${f}" can't be cited`);
      return "";
    }
    const v = renderField(item, f, ctx);
    if (v === null) {
      errors.push(`${where}: ${item.title} has no ${f}`);
      return "";
    }
    used.add(name);
    return v;
  });
  return { out: out.replace(/\s+/g, " ").trim(), used, count };
}

/** The constitution's message check. A failed message never goes out, and the failure is logged. */
export function validateMessage(draft: MessageDraft, ctx: ValidationContext): ValidationResult {
  const errors: string[] = [];
  if (draft.rule_id !== ctx.candidate.rule_id) errors.push("Message rule does not match the candidate's rule");
  if (!ctx.ruleAllowsMessaging(draft.rule_id)) errors.push(`Rule ${draft.rule_id} is not an approved, active messaging rule`);
  if (ctx.candidate.action.kind !== "suggest") errors.push("This rule's action does not allow messages");

  const cited = new Set(draft.cited_item_ids);
  if (!cited.size) errors.push("No cited items: every unprompted message must cite at least one real item");
  for (const id of cited) {
    if (!ctx.getItem(id)) errors.push(`Cited item ${id} does not exist`);
    if (!ctx.candidate.item_ids.includes(id)) errors.push(`Cited item ${id} isn't part of what the rule found`);
  }

  const head = render(draft.headline, cited, ctx, errors, "headline");
  const because = render(draft.because, cited, ctx, errors, "because");
  if (because.count === 0) errors.push("The because line must be built from cited items (no placeholders found)");

  const bareHead = draft.headline.replace(PLACEHOLDER, " ");
  const bareBecause = draft.because.replace(PLACEHOLDER, " ");
  for (const [where, bare] of [
    ["headline", bareHead],
    ["because", bareBecause],
  ] as const) {
    if (/\d/.test(bare)) errors.push(`${where}: numbers must come from placeholders, not free text`);
    const claim = CLAIM_WORDS.exec(bare);
    if (claim) errors.push(`${where}: "${claim[0]}" states a fact about time or status outside a placeholder`);
  }
  const allText = [head.out, because.out, ...draft.options.map((o) => o.label)].join(" \n ");
  const mind = STATE_OF_MIND.exec(allText);
  if (mind) errors.push(`Claims a state of mind ("${mind[0]}"), which the constitution forbids`);

  if (draft.options.length < 2 || draft.options.length > 4) errors.push(`Needs 2 to 4 options, got ${draft.options.length}`);
  for (const o of draft.options) {
    const r = OptionActionSchema.safeParse(o.action);
    if (!r.success) errors.push(`Option "${o.label}" has an invalid action`);
    const a = o.action as { item_id?: string };
    if (a.item_id && !ctx.getItem(a.item_id)) errors.push(`Option "${o.label}" points at a missing item`);
  }

  const praise = detectAffirmations(`${head.out} ${because.out}`);
  if (praise.length && !ctx.allowCompletionAck) errors.push(`Operational messages carry no praise ("${praise[0]}")`);

  if (ctx.recentlySent(ctx.candidate.dedupe_key)) errors.push("The same nudge went out within its cooldown");
  if (head.out.length > 140) errors.push("Headline is too long");
  if (because.out.length > 280) errors.push("Because line is too long");
  if (!head.out) errors.push("Headline is empty");

  return { ok: errors.length === 0, errors, rendered: errors.length ? null : { headline: head.out, because: because.out } };
}
