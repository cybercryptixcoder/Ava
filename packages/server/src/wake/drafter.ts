import { z } from "zod";
import { DateTime } from "luxon";
import type { MessageOption } from "@ava/shared";
import type { Services } from "../core/services";
import type { Candidate } from "../rules/candidates";
import type { MessageDraft } from "../validator/message-validator";
import { ITEM_FIELDS } from "../validator/message-validator";
import { ModelUnavailableError, BudgetExceededError } from "../models/types";

const DraftOutputSchema = z.object({
  messages: z.array(
    z.object({
      candidate: z.number().int(),
      headline: z.string(),
      because: z.string(),
      cited_item_ids: z.array(z.string()),
      options: z.array(
        z.object({
          label: z.string(),
          suggestion: z.number().int().nullable(),
          executor: z.enum(["practice_set", "summary", "draft", "outline", "plan"]).nullable(),
          instructions: z.string().nullable(),
        }),
      ),
      urgency: z.enum(["now", "today", "brief"]),
    }),
  ),
  skipped: z.array(z.object({ candidate: z.number().int(), why: z.string() })),
  follow_up_wakes: z.array(z.object({ at_local: z.string(), reason: z.string(), item_ids: z.array(z.string()) })),
});
export type DraftOutput = z.infer<typeof DraftOutputSchema>;

export interface DraftResult {
  drafts: { candidate: Candidate; draft: MessageDraft }[];
  skipped: { candidate: Candidate; why: string }[];
  followUps: { at: Date; reason: string; item_ids: string[] }[];
  draftedBy: "model" | "fallback_template";
  modelError: string | null;
}

const SYSTEM = `You are the ranking and drafting step inside Ava, a personal agent for one person. The system has already decided, with deterministic rules, that each candidate below is a legitimate reason to maybe reach out. Your job is bounded:

1. Rank the candidates and choose at most the number you're allowed (it can be zero). Prefer what helps him finish things, what is time-sensitive, and what he hasn't been nudged about recently.
2. For each chosen candidate, draft one message:
   - headline: the point, in one short line. No greeting.
   - because: one sentence explaining why, built ONLY from placeholders for facts.
   - 2 to 4 options, each ideally offering to start the work for him.
3. Optionally request follow-up wakes (local time "YYYY-MM-DDTHH:MM") when a precise later moment matters. The scheduler validates them; most of the time request none.

Facts rule (enforced by a validator that drops failing messages):
- Every fact must be a placeholder. Use {{item:<id>.<field>}} for cited items, fields: ${ITEM_FIELDS.join(", ")}. Use {{fact:<name>}} for the candidate's listed facts.
- Outside placeholders, never write digits, dates, times, weekdays, or status words (started, done, finished, drafted, overdue, late, still, already, never, today, tomorrow, days, hours...). Those only come from placeholders.
- Cite only the candidate's items. cited_item_ids must list every item you reference.
- Never say or imply how he feels or seems (stressed, tired, avoiding, procrastinating...). No praise, no exclamation marks, no emoji.

Options: reuse a suggested option by its index in "suggestion" (you may reword its label), or set "executor" + "instructions" to offer new preparatory work. Labels say exactly what will happen, in a few words, sentence case.`;

export class Drafter {
  constructor(private svc: Services) {}

  private candidateBlock(cands: Candidate[]): string {
    const { items, clock, settings } = this.svc;
    const now = clock.now();
    const tz = settings.tz();
    return cands
      .map((c, i) => {
        const its = items.byIds(c.item_ids).map((it) => {
          const h = items.hydrate(it, now, tz);
          return `    - ${it.id} | ${it.type} | "${it.title}" | status: ${h.status_label}${h.due_phrase ? ` | due ${h.due_phrase}` : ""}${h.project_title ? ` | project: ${h.project_title}` : ""}${h.estimate_minutes ? ` | est ${h.estimate_minutes} min` : ""}`;
        });
        const facts = Object.entries(c.facts).map(([k, v]) => `{{fact:${k}}} = ${v}`);
        const opts = c.suggested_options.map((o, k) => `    ${k}: ${o.label}`);
        return [
          `Candidate ${i} — rule "${c.rule_name}" (${c.tier}), urgency ${c.urgency}`,
          `  intent: ${c.intent}`,
          `  items:`,
          ...its,
          facts.length ? `  facts: ${facts.join("; ")}` : `  facts: none`,
          opts.length ? `  suggested options:\n${opts.join("\n")}` : "  suggested options: none",
        ].join("\n");
      })
      .join("\n\n");
  }

  async draft(cands: Candidate[], opts: { allowed: number; wakeId: string; recentHeadlines: string[] }): Promise<DraftResult> {
    const { models, cfg, personality, clock, settings } = this.svc;
    if (!cands.length || opts.allowed <= 0) {
      return { drafts: [], skipped: cands.map((c) => ({ candidate: c, why: "no messages allowed right now" })), followUps: [], draftedBy: "model", modelError: null };
    }
    const tz = settings.tz();
    const local = DateTime.fromJSDate(clock.now()).setZone(tz);
    try {
      const res = await models.complete({
        purpose: "wake.rank_and_draft",
        origin: "system",
        model: cfg.models.fast,
        maxTokens: 3000,
        wakeId: opts.wakeId,
        system: [
          { text: SYSTEM, cache: false },
          { text: `How operational messages read:\n${personality.operational()}`, cache: true },
        ],
        schema: DraftOutputSchema,
        messages: [
          {
            role: "user",
            content: `Now: ${local.toFormat("cccc d LLL yyyy, HH:mm")} (${tz}).
You may choose at most ${opts.allowed} candidate(s).
Messages already sent today: ${opts.recentHeadlines.length ? opts.recentHeadlines.map((h) => `"${h}"`).join("; ") : "none"}.

${this.candidateBlock(cands)}`,
          },
        ],
      });
      if (!res.parsed) throw new Error(res.parseError ?? "No draft returned");
      return { ...this.fromModel(res.parsed, cands, opts.allowed), draftedBy: "model", modelError: null };
    } catch (e) {
      const reason =
        e instanceof ModelUnavailableError ? "no model key" : e instanceof BudgetExceededError ? "model budget reached" : `model error: ${(e as Error).message}`;
      this.svc.log.warn("wake.fallback_draft", `Drafting with deterministic templates (${reason})`, undefined, opts.wakeId);
      const chosen = cands.slice(0, opts.allowed);
      return {
        drafts: chosen.map((c) => ({ candidate: c, draft: templateDraft(c, this.svc.items.get(c.item_ids[0])?.due_at ?? null) })),
        skipped: cands.slice(opts.allowed).map((c) => ({ candidate: c, why: "over the allowed count" })),
        followUps: [],
        draftedBy: "fallback_template",
        modelError: reason,
      };
    }
  }

  private fromModel(out: DraftOutput, cands: Candidate[], allowed: number): Omit<DraftResult, "draftedBy" | "modelError"> {
    const tz = this.svc.settings.tz();
    const drafts: DraftResult["drafts"] = [];
    const used = new Set<number>();
    for (const m of out.messages) {
      const c = cands[m.candidate];
      if (!c || used.has(m.candidate) || drafts.length >= allowed) continue;
      used.add(m.candidate);
      const options: MessageOption[] = [];
      for (const o of m.options) {
        if (options.length >= 4) break;
        const sug = o.suggestion !== null ? c.suggested_options[o.suggestion] : undefined;
        if (sug) options.push({ key: `o${options.length + 1}`, label: o.label || sug.label, action: sug.action as MessageOption["action"] });
        else if (o.executor && o.instructions) {
          options.push({
            key: `o${options.length + 1}`,
            label: o.label,
            action: { kind: "start_executor", executor: o.executor, item_id: c.item_ids[0], instructions: o.instructions },
          });
        }
      }
      for (const s of c.suggested_options) {
        if (options.length >= 2) break;
        if (!options.some((o) => o.label === s.label)) options.push({ key: `o${options.length + 1}`, label: s.label, action: s.action as MessageOption["action"] });
      }
      drafts.push({
        candidate: c,
        draft: {
          rule_id: c.rule_id,
          headline: m.headline,
          because: m.because,
          cited_item_ids: m.cited_item_ids.length ? m.cited_item_ids : c.item_ids,
          options,
          urgency: m.urgency,
        },
      });
    }
    const skipped = cands.filter((_c, i) => !used.has(i)).map((c) => ({ candidate: c, why: out.skipped.find((s) => cands[s.candidate] === c)?.why ?? "not chosen" }));
    const followUps = out.follow_up_wakes
      .map((f) => ({ at: DateTime.fromISO(f.at_local, { zone: tz }).toJSDate(), reason: f.reason, item_ids: f.item_ids }))
      .filter((f) => !Number.isNaN(f.at.getTime()));
    return { drafts, skipped, followUps };
  }
}

/** Deterministic drafts, used when the model is unavailable or over budget. Still validated. */
export function templateDraft(c: Candidate, firstDueAt: string | null = null): MessageDraft {
  const id = c.item_ids[0];
  const second = c.item_ids[1];
  const options: MessageOption[] = c.suggested_options.slice(0, 4).map((o, i) => ({ key: `o${i + 1}`, label: o.label, action: o.action as MessageOption["action"] }));
  if (options.length < 2) options.push({ key: `o${options.length + 1}`, label: "Show it in Tasks", action: { kind: "open", screen: "tasks" } });
  let headline: string;
  let because: string;
  switch (c.rule_id) {
    case "builtin.deadline_horizon":
      headline = `{{item:${id}.title}} is due {{item:${id}.due}}`;
      because = `{{item:${id}.title}} is {{item:${id}.status}} with {{fact:days_left}} to go.`;
      break;
    case "builtin.free_block":
      headline = `Free from {{fact:block_start}} to {{fact:block_end}}`;
      because = `You have {{fact:block_minutes}} open and {{item:${id}.title}} fits${second ? `, as does {{item:${second}.title}}` : ""}.`;
      break;
    case "builtin.finish_line":
      headline = `{{item:${id}.title}} is one step from the end`;
      because = `{{item:${id}.title}} has been {{item:${id}.status}} for {{item:${id}.days_in_status}}.`;
      break;
    case "builtin.stale_project":
      headline = `Pick {{item:${id}.title}} back up?`;
      because = `{{item:${id}.title}} was last touched {{item:${id}.days_since_touched}} ago.`;
      break;
    case "builtin.follow_up":
      headline = `Close the loop: {{item:${id}.title}}`;
      because = firstDueAt ? `{{item:${id}.title}} was due {{item:${id}.due}}.` : `{{item:${id}.title}} is {{item:${id}.status}}.`;
      break;
    default:
      headline = `{{item:${id}.title}}`;
      because = `{{item:${id}.title}} is {{item:${id}.status}}.`;
  }
  return { rule_id: c.rule_id, headline, because, cited_item_ids: c.item_ids, options, urgency: c.urgency };
}
