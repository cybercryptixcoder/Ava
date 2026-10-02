import { z } from "zod";
import { ItemTypeSchema } from "./items";

/**
 * Dynamic rules are structured, human-readable conditions over fields that
 * exist in the state model. The system evaluates them deterministically; the
 * model only proposes them. Shreyas can read and edit them by hand.
 *
 * Field namespaces:
 *   now.*        local clock: now.local_hour, now.local_minutes, now.weekday, now.is_weekend
 *   location.*   location.id ("state-college" | "bangalore")
 *   calendar.*   calendar.in_event, calendar.in_class, calendar.next_event_minutes,
 *                calendar.free_minutes_now, calendar.minutes_since_class_ended
 *   activity.*   activity.active_minutes_last_hour, activity.current_category
 *   counts.*     counts.open_tasks, counts.overdue_tasks, counts.messages_today
 *   item.*       per-item fields when the rule has for_each (see ITEM_FIELDS)
 *   ref.<id>.*   a specific item, e.g. ref.tsk_ab12.status
 */

export const OPS = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "not_in",
  "contains",
  "not_contains",
  "between",
  "exists",
  "not_exists",
] as const;
export type Op = (typeof OPS)[number];

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { field: string; op: Op; value?: unknown };

const FIELD_PATTERN = /^(now|location|calendar|activity|counts|item|ref)\.[a-z0-9_.]+$/i;

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ConditionSchema).min(1) }).strict(),
    z.object({ any: z.array(ConditionSchema).min(1) }).strict(),
    z.object({ not: ConditionSchema }).strict(),
    z
      .object({
        field: z.string().regex(FIELD_PATTERN, "Unknown field namespace"),
        op: z.enum(OPS),
        value: z.unknown().optional(),
      })
      .strict(),
  ]),
);

export const ITEM_FIELDS: Record<string, string> = {
  "item.type": "item type",
  "item.status": "status",
  "item.title": "title",
  "item.tags": "tags",
  "item.importance": "importance",
  "item.kind": "kind",
  "item.course": "course",
  "item.project_id": "project",
  "item.estimate_minutes": "estimated minutes",
  "item.days_until_due": "days until due",
  "item.hours_until_due": "hours until due",
  "item.days_since_touched": "days since touched",
  "item.days_in_status": "days in current status",
  "item.days_overdue": "days overdue",
  "item.fits_free_block": "fits the current free block",
};

export const CONTEXT_FIELDS: Record<string, string> = {
  "now.local_hour": "the hour",
  "now.local_minutes": "minutes past midnight",
  "now.weekday": "the weekday",
  "now.is_weekend": "it's the weekend",
  "location.id": "location",
  "calendar.in_event": "you're in a calendar event",
  "calendar.in_class": "you're in class",
  "calendar.next_event_minutes": "minutes until the next event",
  "calendar.free_minutes_now": "free minutes from now",
  "calendar.minutes_since_class_ended": "minutes since a class ended",
  "activity.active_minutes_last_hour": "active laptop minutes in the last hour",
  "activity.current_category": "current activity",
  "counts.open_tasks": "open tasks",
  "counts.overdue_tasks": "overdue tasks",
  "counts.messages_today": "messages sent today",
};

export const RuleActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("suggest"),
      /** What the message is for, in plain words. The wake model drafts the actual text. */
      intent: z.string().min(3).max(300),
      /** Suggested options; the model may refine them. */
      options: z.array(z.string().min(1).max(80)).max(4).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("prepare"),
      executor: z.enum(["practice_set", "summary", "draft", "outline", "plan"]),
      instructions: z.string().min(3).max(600),
    })
    .strict(),
  z
    .object({
      kind: z.literal("wake"),
      reason: z.string().min(3).max(200),
      /** Offset from the firing moment. */
      in_minutes: z.number().int().min(5).max(24 * 60).optional(),
      /** Or a local time later today/tomorrow. */
      at_local: z
        .string()
        .regex(/^\d{1,2}:\d{2}$/)
        .optional(),
    })
    .strict(),
]);
export type RuleAction = z.infer<typeof RuleActionSchema>;

export const RuleExpirySchema = z
  .object({
    at: z.string().optional(),
    when: ConditionSchema.optional(),
  })
  .strict()
  .refine((e) => e.at || e.when, "An expiry needs a date, a condition, or both");
export type RuleExpiry = z.infer<typeof RuleExpirySchema>;

export const DynamicRuleDefinitionSchema = z
  .object({
    when: ConditionSchema.optional(),
    for_each: z
      .object({
        type: z.union([ItemTypeSchema, z.array(ItemTypeSchema).min(1)]),
        where: ConditionSchema.optional(),
      })
      .strict()
      .optional(),
    /** Max items cited per firing. */
    limit: z.number().int().min(1).max(5).optional(),
    action: RuleActionSchema,
    cooldown_hours: z.number().min(1).max(24 * 14).optional(),
    category: z.string().max(40).optional(),
  })
  .strict();
export type DynamicRuleDefinition = z.infer<typeof DynamicRuleDefinitionSchema>;

export const RuleStatusSchema = z.enum([
  "proposed",
  "active",
  "paused",
  "paused_low_precision",
  "expired",
  "rejected",
]);
export type RuleStatus = z.infer<typeof RuleStatusSchema>;

export interface RuleStats {
  fired: number;
  messages: number;
  acted: number;
  not_now: number;
  already_done: number;
  less_of_this: number;
  ignored: number;
  precision: number | null;
  last_fired_at: string | null;
}

export interface RuleView {
  id: string;
  tier: "constitution" | "builtin" | "dynamic";
  name: string;
  description: string;
  evidence: string | null;
  definition: DynamicRuleDefinition | null;
  readable: string;
  action_kind: RuleAction["kind"] | "system";
  approval_tier: "auto" | "needs_approval" | "fixed";
  status: RuleStatus;
  enabled: boolean;
  expires_at: string | null;
  expiry: RuleExpiry | null;
  created_by: string;
  created_at: string;
  stats: RuleStats;
  shadow: ShadowResult | null;
  revision_of: string | null;
  proposed_revision: string | null;
  params?: Record<string, unknown>;
}

export interface ShadowFiring {
  at: string;
  item_ids: string[];
  item_titles: string[];
  outcome: "would_message" | "would_queue_for_brief" | "blocked_quiet_hours" | "blocked_class" | "blocked_cap" | "blocked_cooldown" | "would_prepare" | "would_wake";
  note: string;
}

export interface ShadowResult {
  from: string;
  to: string;
  snapshots_checked: number;
  firings: ShadowFiring[];
  computed_at: string;
}

// ---------------------------------------------------------------------------
// Evaluation (pure, deterministic)
// ---------------------------------------------------------------------------

export type Resolver = (field: string) => unknown;

function cmp(a: unknown, b: unknown): number | null {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

function eq(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

export function evaluateLeaf(actual: unknown, op: Op, value: unknown): boolean {
  switch (op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "not_exists":
      return actual === undefined || actual === null;
    case "eq":
      return eq(actual, value);
    case "ne":
      return !eq(actual, value);
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      if (actual === null || actual === undefined) return false;
      const c = cmp(actual, value);
      if (c === null) return false;
      return op === "lt" ? c < 0 : op === "lte" ? c <= 0 : op === "gt" ? c > 0 : c >= 0;
    }
    case "between": {
      if (!Array.isArray(value) || value.length !== 2) return false;
      if (actual === null || actual === undefined) return false;
      const lo = cmp(actual, value[0]);
      const hi = cmp(actual, value[1]);
      return lo !== null && hi !== null && lo >= 0 && hi <= 0;
    }
    case "in":
      return Array.isArray(value) && value.some((v) => eq(actual, v));
    case "not_in":
      return Array.isArray(value) && !value.some((v) => eq(actual, v));
    case "contains":
      if (Array.isArray(actual)) return actual.some((v) => eq(v, value));
      if (typeof actual === "string" && typeof value === "string") return actual.toLowerCase().includes(value.toLowerCase());
      return false;
    case "not_contains":
      if (Array.isArray(actual)) return !actual.some((v) => eq(v, value));
      if (typeof actual === "string" && typeof value === "string") return !actual.toLowerCase().includes(value.toLowerCase());
      return true;
  }
}

export function evaluateCondition(cond: Condition, resolve: Resolver): boolean {
  if ("all" in cond) return cond.all.every((c) => evaluateCondition(c, resolve));
  if ("any" in cond) return cond.any.some((c) => evaluateCondition(c, resolve));
  if ("not" in cond) return !evaluateCondition(cond.not, resolve);
  return evaluateLeaf(resolve(cond.field), cond.op, cond.value);
}

export function conditionFields(cond: Condition | undefined): string[] {
  if (!cond) return [];
  if ("all" in cond) return cond.all.flatMap(conditionFields);
  if ("any" in cond) return cond.any.flatMap(conditionFields);
  if ("not" in cond) return conditionFields(cond.not);
  return [cond.field];
}

// ---------------------------------------------------------------------------
// Human-readable rendering
// ---------------------------------------------------------------------------

const OP_WORDS: Record<Op, string> = {
  eq: "is",
  ne: "is not",
  lt: "is under",
  lte: "is at most",
  gt: "is over",
  gte: "is at least",
  in: "is one of",
  not_in: "is not one of",
  contains: "includes",
  not_contains: "doesn't include",
  between: "is between",
  exists: "is set",
  not_exists: "is not set",
};

function fieldWords(field: string): string {
  if (ITEM_FIELDS[field]) return ITEM_FIELDS[field];
  if (CONTEXT_FIELDS[field]) return CONTEXT_FIELDS[field];
  if (field.startsWith("ref.")) {
    const [, id, ...rest] = field.split(".");
    return `${id}'s ${rest.join(".").replace(/_/g, " ")}`;
  }
  return field.replace(/^[a-z]+\./, "").replace(/[._]/g, " ");
}

function valueWords(v: unknown): string {
  if (Array.isArray(v)) {
    const parts = v.map(valueWords);
    if (parts.length <= 1) return parts.join("");
    return `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
  }
  if (typeof v === "string") return v.replace(/_/g, " ");
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

export function describeCondition(cond: Condition): string {
  if ("all" in cond) return cond.all.map(describeCondition).join(" and ");
  if ("any" in cond) return `(${cond.any.map(describeCondition).join(" or ")})`;
  if ("not" in cond) return `not (${describeCondition(cond.not)})`;
  const f = fieldWords(cond.field);
  if (cond.op === "between" && Array.isArray(cond.value)) return `${f} is between ${valueWords(cond.value[0])} and ${valueWords(cond.value[1])}`;
  if (cond.op === "eq" && typeof cond.value === "boolean" && /^(calendar\.in_|now\.is_|item\.fits)/.test(cond.field)) {
    return cond.value ? f : `not ${f}`;
  }
  if (cond.op === "exists" || cond.op === "not_exists") return `${f} ${OP_WORDS[cond.op]}`;
  return `${f} ${OP_WORDS[cond.op]} ${valueWords(cond.value)}`;
}

export function describeAction(a: RuleAction): string {
  switch (a.kind) {
    case "suggest":
      return `suggest: ${a.intent}`;
    case "prepare":
      return `prepare a ${a.executor.replace(/_/g, " ")} silently: ${a.instructions}`;
    case "wake":
      return `wake Ava ${a.in_minutes ? `${a.in_minutes} min later` : a.at_local ? `at ${a.at_local}` : "later"}: ${a.reason}`;
  }
}

export function describeRule(def: DynamicRuleDefinition): string {
  const parts: string[] = [];
  if (def.when) parts.push(`When ${describeCondition(def.when)}`);
  if (def.for_each) {
    const types = Array.isArray(def.for_each.type) ? def.for_each.type : [def.for_each.type];
    const t = types.map((x) => x.replace(/_/g, " ")).join(" or ");
    parts.push(`for each ${t}${def.for_each.where ? ` where ${describeCondition(def.for_each.where)}` : ""}`);
  }
  const head = parts.length ? parts.join(", ") : "On every wake";
  const cooldown = def.cooldown_hours ? ` At most once every ${def.cooldown_hours} h.` : "";
  return `${head}: ${describeAction(def.action)}.${cooldown}`;
}

export function actionNeedsApproval(a: RuleAction): boolean {
  return a.kind === "suggest";
}
