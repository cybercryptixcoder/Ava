import { formatClock, type RuleAction } from "@ava/shared";
import type { Settings } from "../config/settings";
import type { Candidate, SuggestedOption } from "./candidates";
import { freeBlocks, itemMetrics, openItems, type WorldItem, type WorldState } from "./world";

export interface BuiltinRule {
  id: string;
  name: string;
  description: string;
  category: string;
  /** Settings keys (under settings.rules) this rule reads, for display. */
  params: (s: Settings) => Record<string, unknown>;
  evaluate(w: WorldState, s: Settings): Candidate[];
}

const suggest = (intent: string): RuleAction => ({ kind: "suggest", intent });

function prepOption(i: WorldItem): SuggestedOption {
  if (["quiz", "exam", "midterm", "final", "test"].includes(i.kind ?? "")) {
    return {
      label: "Make me a practice set",
      action: { kind: "start_executor", executor: "practice_set", item_id: i.id, instructions: `Practice set for ${i.title}` },
    };
  }
  return {
    label: "Break it into steps",
    action: { kind: "start_executor", executor: "plan", item_id: i.id, instructions: `A short step plan to start ${i.title}` },
  };
}

const snooze = (i: WorldItem, hours = 24): SuggestedOption => ({
  label: hours >= 24 ? "Remind me tomorrow" : `Remind me in ${hours} hours`,
  action: { kind: "snooze_item", item_id: i.id, hours },
});

/** Deadline horizon: due in 14, 3 or 1 days, and the status isn't "started" or "done". */
const deadlineHorizon: BuiltinRule = {
  id: "builtin.deadline_horizon",
  name: "Deadline horizon",
  description: "A deadline is 14, 3 or 1 days out and the work hasn't started.",
  category: "deadlines",
  params: (s) => ({ offsets_days: s.deadline_offsets_days }),
  evaluate(w, s) {
    const now = new Date(w.at);
    const out: Candidate[] = [];
    for (const i of openItems(w, ["task", "commitment"])) {
      if (!i.due_at) continue;
      if (["started", "drafted", "almost_done", "done"].includes(i.status)) continue;
      const m = itemMetrics(i, now, w.tz);
      if (m.days_until_due === null || m.hours_until_due === null || m.hours_until_due <= 0) continue;
      const offset = s.deadline_offsets_days.find((d) => d === m.days_until_due);
      if (offset === undefined) continue;
      out.push({
        rule_id: this.id,
        rule_name: this.name,
        tier: "builtin",
        action: suggest(`${i.title} is ${offset} day${offset === 1 ? "" : "s"} out and not started`),
        item_ids: [i.id],
        facts: { days_left: `${offset} day${offset === 1 ? "" : "s"}` },
        intent: `Get ${i.title} started; it is due in ${offset} day${offset === 1 ? "" : "s"} and not started.`,
        suggested_options: [prepOption(i), snooze(i, offset === 1 ? 3 : 24)],
        urgency: offset <= 1 ? "now" : offset <= 3 ? "today" : "brief",
        dedupe_key: `${this.id}:${i.id}:${offset}`,
        cooldown_hours: 20,
        category: this.category,
        priority: offset <= 1 ? 90 : offset <= 3 ? 70 : 40,
      });
    }
    return out;
  },
};

/**
 * Free block: an open block of at least 60 minutes starts within 15 minutes,
 * outside sleep hours, and some pending item fits in that time.
 */
const freeBlock: BuiltinRule = {
  id: "builtin.free_block",
  name: "Free block",
  description: "An open block of an hour or more starts soon and something pending fits in it.",
  category: "free_time",
  params: (s) => ({ min_minutes: s.rules.free_block_min_minutes, lead_minutes: s.rules.free_block_lead_minutes }),
  evaluate(w, s) {
    const now = new Date(w.at);
    const lead = s.rules.free_block_lead_minutes * 60_000;
    const block = freeBlocks(w, now, 6).find(
      (b) => b.minutes >= s.rules.free_block_min_minutes && new Date(b.start).getTime() - now.getTime() <= lead && new Date(b.end) > now,
    );
    if (!block) return [];
    const remaining = Math.round((new Date(block.end).getTime() - Math.max(now.getTime(), new Date(block.start).getTime())) / 60_000);
    if (remaining < s.rules.free_block_min_minutes) return [];
    const pending = openItems(w, ["task", "saved_item"])
      .filter((i) => !["done", "dropped"].includes(i.status))
      .filter((i) => (i.estimate_minutes ?? 45) <= remaining)
      .map((i) => {
        const m = itemMetrics(i, now, w.tz);
        const urgency = m.hours_until_due !== null ? Math.max(0, 200 - m.hours_until_due) : 0;
        const finish = ["drafted", "almost_done"].includes(i.status) ? 60 : 0;
        const saved = i.type === "saved_item" ? -40 : 0;
        return { i, score: urgency + finish + (i.importance ?? 0) * 10 + saved };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((x) => x.i);
    if (!pending.length) return [];
    const top = pending[0];
    return [
      {
        rule_id: this.id,
        rule_name: this.name,
        tier: "builtin",
        action: suggest("Use the coming free block"),
        item_ids: pending.map((p) => p.id),
        facts: {
          block_start: formatClock(block.start, w.tz),
          block_end: formatClock(block.end, w.tz),
          block_minutes: `${remaining} minutes`,
        },
        intent: `A ${remaining}-minute free block starts at ${formatClock(block.start, w.tz)}; suggest using it for one of the cited items.`,
        suggested_options: [
          { label: `Start ${top.title}`, action: { kind: "start_executor", executor: "plan", item_id: top.id, instructions: `A plan for the next ${remaining} minutes on ${top.title}` } },
          ...(pending[1]
            ? [
                {
                  label: `Do ${pending[1].title} instead`,
                  action: { kind: "start_executor", executor: "plan", item_id: pending[1].id, instructions: `A plan for the next ${remaining} minutes on ${pending[1].title}` },
                } as SuggestedOption,
              ]
            : []),
          { label: "Leave the block free", action: { kind: "none" } },
        ],
        urgency: "now",
        // The block's end identifies it; its start moves as "now" moves.
        dedupe_key: `${this.id}:${block.end.slice(0, 16)}`,
        cooldown_hours: 2,
        category: this.category,
        priority: 60,
        queueable: false,
      },
    ];
  },
};

/** Finish line: something has sat at "drafted" or "almost done" for 2+ days. */
const finishLine: BuiltinRule = {
  id: "builtin.finish_line",
  name: "Finish line",
  description: "Something has been drafted or almost done for two days or more.",
  category: "finishing",
  params: (s) => ({ days: s.rules.finish_line_days }),
  evaluate(w, s) {
    const now = new Date(w.at);
    return openItems(w, ["task", "commitment"])
      .filter((i) => ["drafted", "almost_done"].includes(i.status))
      .filter((i) => itemMetrics(i, now, w.tz).days_in_status >= s.rules.finish_line_days)
      .map((i) => {
        const days = Math.floor(itemMetrics(i, now, w.tz).days_in_status);
        return {
          rule_id: this.id,
          rule_name: this.name,
          tier: "builtin" as const,
          action: suggest("Finish the last step"),
          item_ids: [i.id],
          facts: { days_waiting: `${days} day${days === 1 ? "" : "s"}` },
          intent: `${i.title} has been ${i.status.replace("_", " ")} for ${days} days; help Shreyas take the final step.`,
          suggested_options: [
            {
              label: "Show me what's left",
              action: { kind: "start_executor", executor: "summary", item_id: i.id, instructions: `Summarize where ${i.title} stands and list exactly what remains to finish it` },
            },
            { label: "Mark it done", action: { kind: "propose_change", change: { op: "complete_item", item_id: i.id }, summary: `Mark ${i.title} done` } },
            snooze(i, 24),
          ],
          urgency: "today" as const,
          dedupe_key: `${this.id}:${i.id}`,
          cooldown_hours: 44,
          category: this.category,
          priority: 80,
        };
      });
  },
};

/** Stale project: a project marked important hasn't been touched in 7+ days. */
const staleProject: BuiltinRule = {
  id: "builtin.stale_project",
  name: "Stale project",
  description: "An important project hasn't been touched in a week.",
  category: "projects",
  params: (s) => ({ days: s.rules.stale_project_days }),
  evaluate(w, s) {
    const now = new Date(w.at);
    return openItems(w, ["project"])
      .filter((p) => p.status === "active" && p.important)
      .filter((p) => itemMetrics(p, now, w.tz).days_since_touched >= s.rules.stale_project_days)
      .map((p) => {
        const days = Math.floor(itemMetrics(p, now, w.tz).days_since_touched);
        return {
          rule_id: this.id,
          rule_name: this.name,
          tier: "builtin" as const,
          action: suggest("Pick the project back up"),
          item_ids: [p.id],
          facts: { days_untouched: `${days} days` },
          intent: `${p.title} is marked important and untouched for ${days} days; offer a way back in or ask whether it still matters.`,
          suggested_options: [
            { label: "Summarize where I left off", action: { kind: "start_executor", executor: "summary", item_id: p.id, instructions: `Summarize where ${p.title} stands and the next concrete step` } },
            { label: "Pause the project", action: { kind: "propose_change", change: { op: "set_status", item_id: p.id, status: "paused" }, summary: `Pause ${p.title}` } },
            snooze(p, 72),
          ],
          urgency: "brief" as const,
          dedupe_key: `${this.id}:${p.id}`,
          cooldown_hours: 24 * 4,
          category: this.category,
          priority: 35,
        };
      });
  },
};

/** Follow-up: a commitment made to someone, or a reply owed, is overdue. */
const followUp: BuiltinRule = {
  id: "builtin.follow_up",
  name: "Follow-up",
  description: "A commitment to someone, or a reply you owe, is overdue.",
  category: "people",
  params: () => ({ reply_owed_days_without_date: 3 }),
  evaluate(w) {
    const now = new Date(w.at);
    return openItems(w, ["commitment", "open_loop"])
      .filter((i) => i.type === "commitment" || ["reply_owed", "promise"].includes(i.kind ?? ""))
      .filter((i) => {
        if (i.due_at) return new Date(i.due_at) < now;
        return (now.getTime() - new Date(i.created_at).getTime()) / 86_400_000 >= 3 && i.kind === "reply_owed";
      })
      .map((i) => ({
        rule_id: this.id,
        rule_name: this.name,
        tier: "builtin" as const,
        action: suggest("Close the loop with the person"),
        item_ids: [i.id],
        facts: (i.to_person ? { person: i.to_person } : {}) as Record<string, string>,
        intent: `${i.title}${i.to_person ? ` (to ${i.to_person})` : ""} is overdue; offer to draft the follow-up.`,
        suggested_options: [
          { label: "Draft the reply", action: { kind: "start_executor", executor: "draft", item_id: i.id, instructions: `Draft a short message for: ${i.title}` } },
          { label: "Already handled", action: { kind: "propose_change", change: { op: "complete_item", item_id: i.id }, summary: `Close ${i.title}` } },
          snooze(i, 24),
        ],
        urgency: "today" as const,
        dedupe_key: `${this.id}:${i.id}`,
        cooldown_hours: 44,
        category: this.category,
        priority: 75,
      }));
  },
};

export const BUILTIN_RULES: BuiltinRule[] = [deadlineHorizon, freeBlock, finishLine, staleProject, followUp];
