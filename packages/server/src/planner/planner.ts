import { z } from "zod";
import { DateTime } from "luxon";
import { inQuietHours } from "@ava/shared";
import type { Services } from "../core/services";
import { js, newId } from "../db/db";
import { BudgetExceededError, ModelUnavailableError } from "../models/types";
import { DSL_GUIDE, lifeModelText, recentActivityText } from "./context";

const RuleProposal = z.object({
  name: z.string(),
  evidence: z.string(),
  definition_json: z.string(),
  expiry_days: z.number().nullable(),
  expiry_condition_json: z.string().nullable(),
});

const PlanOutput = z.object({
  plan_note: z.string(),
  blocks: z.array(z.object({ item_id: z.string().nullable(), title: z.string(), start_local: z.string(), end_local: z.string(), note: z.string().nullable() })),
  wake_requests: z.array(z.object({ at_local: z.string(), reason: z.string(), item_ids: z.array(z.string()) })),
  rule_proposals: z.array(RuleProposal),
  question: z.object({ text: z.string(), why: z.string(), about_item_id: z.string().nullable(), about_belief_id: z.string().nullable() }).nullable(),
  belief_proposals: z.array(z.object({ area: z.string(), statement: z.string(), confidence: z.number(), evidence_note: z.string(), subject_item_id: z.string().nullable() })),
  brief_notes: z.string().nullable(),
  /** Regrouping threads: move items into a thread by title (new or existing), optionally under a group. Empty when the grouping is fine. */
  threads: z.array(z.object({ title: z.string(), item_ids: z.array(z.string()), group: z.string().nullable() })),
});
type PlanOut = z.infer<typeof PlanOutput>;

const WeeklyOutput = PlanOutput.extend({
  review: z.object({ headline: z.string(), paragraphs: z.array(z.string()) }),
  rule_revisions: z.array(RuleProposal.extend({ revises_rule_id: z.string(), why: z.string() })),
});
type WeeklyOut = z.infer<typeof WeeklyOutput>;

const PLANNER_SYSTEM = `You are Ava's planner. Ava is a self-hosted personal agent for one person, Shreyas: a CS student who splits time between Penn State (State College) and Bangalore, thinks out loud, and tends to do all the preparation for something and then stall at the final step. Helping him finish matters more than helping him start.

You plan ahead, with time to think. The system owns time, triggers, execution and enforcement:
- You never schedule anything directly. You return wake requests as data; a deterministic scheduler validates them against budgets and quiet hours and may reject them.
- You never message him directly. Messages come only from approved rules plus real cited items, through a validator.
- You never execute tasks. Fresh executor sessions do that and report back whether the plan still fit reality. Read those reports; you don't grade your own plans.
- You may propose dynamic rules for how his life is going this week. Messaging rules need his approval; wake/prepare rules auto-approve within budget. Every rule expires (default 14 days). Propose at most what's genuinely useful; the system caps proposals per week and active rules overall, so a readable rule set beats a clever one. Ground each rule's evidence in the data you were shown (e.g. "you acted on 4 of 5 study nudges sent 7–9pm and ignored all 3 sent before noon").
- You can ask one well-chosen question when an unknown really matters (e.g. whether a project still matters). Only when the answer would change what Ava does.
- Belief proposals are inferences; they stay unconfirmed until he confirms them. Don't invent states of mind.
- Threads are the few top-level areas of his life right now ("Midterm week", "Finish the SOP", "OS project"); every task, deadline, commitment and open loop sits in one. Keep the top level to about 7: when there are more, group related threads under a broader one (the group field) rather than adding more. Return threads only to regroup or to name a thread better; short, plain titles.

Times are local to his current time zone, formatted "YYYY-MM-DDTHH:MM". Item ids must be real ids from the context. Return empty arrays when there's nothing worth doing; quiet is fine.

${DSL_GUIDE}`;

/**
 * Planning sessions: the evening plan, the weekly review, and focused
 * sessions when something genuinely new enters his life. These are the only
 * places dynamic rules are written. The output is data; everything is
 * validated by the system before it takes effect.
 */
export class Planner {
  constructor(private svc: Services) {}

  private async call<T>(purpose: string, schema: z.ZodType<T>, instruction: string, wakeId: string, days = 7): Promise<{ out: T; callId: string } | { error: string }> {
    const { models, cfg, personality } = this.svc;
    try {
      const res = await models.complete({
        purpose,
        origin: "system",
        model: cfg.models.planner,
        maxTokens: 16000,
        effort: "high",
        wakeId,
        schema,
        system: [
          { text: PLANNER_SYSTEM, cache: true },
          { text: `Ava's voice, for any text he will read:\n${personality.operational()}`, cache: true },
        ],
        messages: [
          {
            role: "user",
            content: `${lifeModelText(this.svc, { calendarDays: purpose === "planner.weekly" ? 7 : 2 })}\n\n${recentActivityText(this.svc, days)}\n\n${this.budgetText()}\n\n${instruction}`,
          },
        ],
      });
      if (!res.parsed) return { error: res.parseError ?? "no output" };
      return { out: res.parsed, callId: res.callId };
    } catch (e) {
      const msg = e instanceof ModelUnavailableError ? "no model key" : e instanceof BudgetExceededError ? e.message : (e as Error).message;
      this.svc.log.warn("planner.skipped", `${purpose} skipped: ${msg}`, undefined, wakeId);
      return { error: msg };
    }
  }

  private budgetText(): string {
    const { rules, settings } = this.svc;
    const s = settings.get();
    return `Budgets: up to ${s.wake_budget.planner_requests_per_day} planner wake requests a day (at least ${s.wake_budget.min_gap_minutes} minutes apart, within ${s.wake_budget.horizon_days} days, never in quiet hours). New rule proposals left this week: ${Math.max(0, s.rules.max_new_per_week - rules.proposalsThisWeek())}. Active dynamic rules: ${rules.activeDynamicCount()} of ${s.rules.max_active_dynamic}.`;
  }

  /** Apply the deterministic parts of a plan. Every piece is validated. */
  private apply(kind: string, out: PlanOut, callId: string, wakeId: string): string[] {
    const { db, clock, settings, scheduler, rules, questions, proposals, log, items } = this.svc;
    const tz = settings.tz();
    const s = settings.get();
    const notes: string[] = [];
    const local = (x: string) => DateTime.fromISO(x, { zone: tz }).toJSDate();
    const planId = newId("pln");
    const forDate = DateTime.fromJSDate(clock.now()).setZone(tz).plus({ days: kind === "evening" ? 1 : 0 }).toISODate();
    db.run("INSERT INTO plans (id, kind, for_date, content, model_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", [planId, kind, forDate, js(out), callId, clock.now().toISOString()]);

    let blocks = 0;
    if (out.blocks.length) {
      // A new plan replaces the previous plan's future blocks.
      db.run("UPDATE plan_blocks SET status = 'cancelled' WHERE status = 'planned' AND start_at >= ?", [clock.now().toISOString()]);
    }
    for (const b of out.blocks) {
      const start = local(b.start_local);
      const end = local(b.end_local);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start || start <= clock.now()) continue;
      if (inQuietHours(start, tz, s.quiet_hours.start, s.quiet_hours.end)) continue;
      if (b.item_id && !items.get(b.item_id)) continue;
      db.run("INSERT INTO plan_blocks (id, plan_id, item_id, title, start_at, end_at, note, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned')", [
        newId("blk"),
        planId,
        b.item_id,
        b.title,
        start.toISOString(),
        end.toISOString(),
        b.note,
      ]);
      blocks++;
    }
    notes.push(`${blocks} planned blocks`);

    let wakes = 0;
    for (const w of out.wake_requests) {
      const at = local(w.at_local);
      const r = scheduler.request({ kind: "planner", at, reason: w.reason, owner: "planner", item_ids: w.item_ids.filter((id) => items.get(id)), anchor: { type: "local", date: w.at_local.slice(0, 10), time: w.at_local.slice(11, 16) } }, wakeId);
      if (r.ok) wakes++;
    }
    notes.push(`${wakes}/${out.wake_requests.length} wake requests accepted`);

    let regrouped = 0;
    for (const t of out.threads) {
      const ids = t.item_ids.filter((id) => items.get(id));
      if (!ids.length) continue;
      const thread = this.svc.threads.move(ids, { title: t.title }, "planner");
      if (t.group) this.svc.threads.nest(thread.id, t.group);
      regrouped++;
    }
    if (out.threads.length) {
      this.svc.threads.enforceCap();
      notes.push(`${regrouped} threads regrouped`);
    }

    let proposed = 0;
    for (const p of out.rule_proposals) {
      const r = this.proposeRule(p, "planner");
      if (r) proposed++;
    }
    notes.push(`${proposed}/${out.rule_proposals.length} rules proposed`);

    if (out.question) {
      const q = questions.add({ text: out.question.text, why: out.question.why, about: { item_id: out.question.about_item_id, belief_id: out.question.about_belief_id } });
      if (q) notes.push("1 question queued");
    }
    if (out.belief_proposals.length) {
      const batch = proposals.createBatch(
        "planner",
        out.belief_proposals.map((b) => ({
          change: { op: "add_belief" as const, belief: { area: b.area, statement: b.statement, provenance: "inferred" as const, confidence: Math.min(0.85, Math.max(0.1, b.confidence)), subject_item_id: b.subject_item_id && items.get(b.subject_item_id) ? b.subject_item_id : null } },
          reason: b.evidence_note,
        })),
      );
      notes.push(`${batch.proposals.length} belief proposals`);
    }
    log.info(`planner.${kind}`, `${kind === "evening" ? "Evening plan" : kind === "weekly" ? "Weekly review" : "Planning session"}: ${out.plan_note}`, { plan_id: planId, notes }, wakeId);
    this.svc.bus.emit({ type: "state.changed", what: ["plan", "rules", "wakes", "proposals"] });
    return notes;
  }

  private proposeRule(p: z.infer<typeof RuleProposal>, by: "planner", revisionOf?: string): string | null {
    const { rules, log } = this.svc;
    let def: unknown;
    let when: unknown;
    try {
      def = JSON.parse(p.definition_json);
      when = p.expiry_condition_json ? JSON.parse(p.expiry_condition_json) : undefined;
    } catch (e) {
      log.warn("rule.proposal_rejected", `Planner proposed "${p.name}" with unreadable JSON: ${(e as Error).message}`);
      return null;
    }
    const r = rules.propose({
      name: p.name,
      evidence: p.evidence,
      definition: def,
      expiry_days: p.expiry_days ?? undefined,
      expiry: when ? ({ when } as never) : null,
      created_by: by,
      revision_of: revisionOf ?? null,
    });
    if (!r.ok) return null;
    // Shadow mode: show what it would have done over the last few days.
    try {
      rules.shadow(r.rule.id);
    } catch (e) {
      log.warn("rule.shadow_failed", `Shadow run failed for "${p.name}": ${(e as Error).message}`);
    }
    if (revisionOf) rules.setProposedRevision(revisionOf, r.rule.id);
    // A rule that would message him asks for his yes as a card, at most about once a week.
    this.svc.cards.forRuleApproval(r.rule.id);
    return r.rule.id;
  }

  async evening(wakeId: string): Promise<string> {
    const r = await this.call(
      "planner.evening",
      PlanOutput,
      `This is the evening planning session. Plan tomorrow: when he could realistically do which work (planned blocks that respect his calendar and rhythms), which precise moments deserve a wake, and whether any rule for this week would help. Favor finishing what's nearly done. If there's an unknown worth one question in the morning brief, ask it. brief_notes: anything the morning brief should mention.`,
      wakeId,
      7,
    );
    if ("error" in r) return `evening plan skipped (${r.error})`;
    return `evening plan: ${this.apply("evening", r.out, r.callId, wakeId).join(", ")}`;
  }

  async newContext(wakeId: string, about: string): Promise<string> {
    const r = await this.call(
      "planner.new_context",
      PlanOutput,
      `Something new entered his life: ${about}. Plan around it: what it implies for the next two weeks, any wakes worth requesting, and whether a rule would help. Don't replan everything; leave blocks empty unless this changes tomorrow.`,
      wakeId,
      3,
    );
    if ("error" in r) return `planning session skipped (${r.error})`;
    return `planning session: ${this.apply("new_context", r.out, r.callId, wakeId).join(", ")}`;
  }

  async weekly(wakeId: string): Promise<string> {
    const { rules, messages, cards, log } = this.svc;
    const paused = rules.list().dynamic.filter((r) => r.status === "paused_low_precision");
    const r = await this.call(
      "planner.weekly",
      WeeklyOutput,
      `This is the Sunday weekly review. Look at the week: what got finished, what stalled, which rules helped (precision) and which didn't. For each rule that paused itself for low precision (${paused.map((p) => `${p.id} "${p.name}"`).join(", ") || "none"}), propose a revision in rule_revisions grounded in the response data, or leave it paused. Propose new rules only if the week's evidence supports them. Write the review for him: headline (one line, the point) and 2–4 short paragraphs, plain and specific, no praise unless something hard actually got finished.`,
      wakeId,
      7,
    );
    if ("error" in r) return `weekly review skipped (${r.error})`;
    const out = r.out as WeeklyOut;
    const notes = this.apply("weekly", out, r.callId, wakeId);
    let revisions = 0;
    for (const rev of out.rule_revisions) {
      if (!rules.row(rev.revises_rule_id)) continue;
      if (this.proposeRule({ ...rev, evidence: `${rev.evidence} (revision: ${rev.why})` }, "planner", rev.revises_rule_id)) revisions++;
    }
    // The weekly review is a system anchor like the brief: not counted against the cap.
    const m = messages.create({
      kind: "weekly_review",
      rule_id: null,
      wake_id: wakeId,
      headline: out.review.headline,
      because: out.review.paragraphs.join("\n\n"),
      cited: [],
      options: [{ key: "o1", label: "Review rule proposals", action: { kind: "open", screen: "rules" } }],
      urgency: "today",
      status: "sent",
      drafted_by: "model",
    });
    // A heads-up in the stack, not a notification.
    cards.forReview(m);
    log.info("planner.weekly_review", `Weekly review in the stack: ${out.review.headline}`, { message_id: m.id, revisions }, wakeId);
    return `weekly review: ${notes.join(", ")}, ${revisions} revisions`;
  }

  /** Request a focused planning session when something genuinely new arrives (budgeted). */
  requestNewContext(about: string): void {
    const { scheduler, counters, settings, log, clock } = this.svc;
    if (counters.get("planning_new.requested") >= settings.get().wake_budget.new_context_planning_per_day) {
      log.info("planner.new_context_skipped", `Not planning for "${about}" now: today's new-context planning budget is used`);
      return;
    }
    counters.add("planning_new.requested");
    scheduler.system({ kind: "planning_new", at: new Date(clock.now().getTime() + 2 * 60_000), reason: `Plan around: ${about}`, owner: "system", payload: { about }, dedupe_key: `planning_new:${about.slice(0, 60)}` });
  }

  latestPlanNote(): string | null {
    const r = this.svc.db.get<{ content: string }>("SELECT content FROM plans WHERE kind IN ('evening','weekly') ORDER BY created_at DESC LIMIT 1");
    if (!r) return null;
    try {
      return (JSON.parse(r.content) as PlanOut).plan_note;
    } catch {
      return null;
    }
  }

}
