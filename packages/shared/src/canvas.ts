import { z } from "zod";
import { ChangeSchema } from "./changes";
import { ItemTypeSchema } from "./items";

/**
 * The canvas protocol. Ava never writes HTML. She emits module *specs*
 * against these schemas; the server validates each spec, hydrates any
 * references from real state (items, rules, beliefs, artifacts), and the app
 * renders the hydrated module. A spec that fails validation or hydration is
 * not rendered, and the failure is logged.
 *
 * Specs can carry segment keys so parts of a module reveal in time with
 * speech: a cue marker [[key.segment]] in Ava's spoken text marks the moment
 * a segment appears.
 */

const Key = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "Module keys are short slugs like plan or opts");

const Title = z.string().min(1).max(120);

export const OptionActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("start_executor"),
    executor: z.enum(["practice_set", "summary", "draft", "outline", "plan"]),
    item_id: z.string().optional(),
    instructions: z.string().min(3).max(800),
  }),
  z.object({ kind: z.literal("propose_change"), change: ChangeSchema, summary: z.string().max(200) }),
  z.object({ kind: z.literal("reply"), text: z.string().min(1).max(300) }),
  z.object({ kind: z.literal("snooze_item"), item_id: z.string(), hours: z.number().min(1).max(24 * 14) }),
  z.object({ kind: z.literal("open"), screen: z.enum(["today", "tasks", "rules", "knows", "messages", "settings"]) }),
  z.object({ kind: z.literal("none") }),
]);
export type OptionAction = z.infer<typeof OptionActionSchema>;

export const DayTimelineSpec = z.object({
  key: Key,
  type: z.literal("day_timeline"),
  title: Title.optional(),
  /** YYYY-MM-DD in the current time zone. Defaults to today. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  highlight_item_ids: z.array(z.string()).max(10).optional(),
});

export const WeekViewSpec = z.object({
  key: Key,
  type: z.literal("week_view"),
  title: Title.optional(),
  week_start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const TaskListSpec = z
  .object({
    key: Key,
    type: z.literal("task_list"),
    title: Title.optional(),
    item_ids: z.array(z.string()).max(30).optional(),
    filter: z
      .object({
        types: z.array(ItemTypeSchema).optional(),
        statuses: z.array(z.string()).optional(),
        project_id: z.string().optional(),
        tag: z.string().optional(),
        due_within_days: z.number().int().min(0).max(90).optional(),
      })
      .optional(),
  })
  .refine((s) => s.item_ids || s.filter, "A task list needs item_ids or a filter");

export const OptionsSpec = z.object({
  key: Key,
  type: z.literal("options"),
  title: Title.optional(),
  prompt: z.string().max(240).optional(),
  options: z
    .array(
      z.object({
        key: Key,
        label: z.string().min(1).max(90),
        detail: z.string().max(240).optional(),
        action: OptionActionSchema,
      }),
    )
    .min(2)
    .max(4),
  recommended: Key.optional(),
});

export const DeadlineHorizonSpec = z.object({
  key: Key,
  type: z.literal("deadline_horizon"),
  title: Title.optional(),
  days: z.number().int().min(1).max(60).optional(),
});

export const ProjectCardSpec = z.object({
  key: Key,
  type: z.literal("project_card"),
  title: Title.optional(),
  project_id: z.string(),
});

export const ArtifactPreviewSpec = z.object({
  key: Key,
  type: z.literal("artifact_preview"),
  title: Title.optional(),
  artifact_id: z.string(),
});

export const ComparisonTableSpec = z
  .object({
    key: Key,
    type: z.literal("comparison_table"),
    title: Title.optional(),
    columns: z.array(z.string().min(1).max(40)).min(1).max(5),
    rows: z
      .array(
        z.object({
          key: Key,
          label: z.string().min(1).max(60),
          cells: z.array(z.string().max(120)),
        }),
      )
      .min(2)
      .max(6),
    recommended_row: Key.optional(),
  })
  .refine((s) => s.rows.every((r) => r.cells.length === s.columns.length), "Each row needs one cell per column");

export const RuleCardSpec = z.object({
  key: Key,
  type: z.literal("rule_card"),
  title: Title.optional(),
  rule_id: z.string(),
});

export const BeliefCardSpec = z
  .object({
    key: Key,
    type: z.literal("belief_card"),
    title: Title.optional(),
    belief_ids: z.array(z.string()).max(12).optional(),
    area: z.string().optional(),
  })
  .refine((s) => s.belief_ids || s.area, "A belief card needs belief_ids or an area");

export const ConfirmationChipsSpec = z.object({
  key: Key,
  type: z.literal("confirmation_chips"),
  title: Title.optional(),
  batch_id: z.string(),
});

export const NoteSpec = z.object({
  key: Key,
  type: z.literal("note"),
  title: Title.optional(),
  /** Short paragraphs, separated by blank lines. No markdown. */
  body: z.string().min(1).max(1600),
  tone: z.enum(["plain", "caution"]).optional(),
});

export const RhythmViewSpec = z.object({
  key: Key,
  type: z.literal("rhythm_view"),
  title: Title.optional(),
  metric: z.enum(["work", "study", "sleep", "active"]),
  days: z.number().int().min(3).max(60).optional(),
});

export const CHART_METRICS = [
  "tasks_completed",
  "active_minutes",
  "study_minutes",
  "messages_acted_rate",
  "open_tasks",
] as const;

export const ChartSpec = z.object({
  key: Key,
  type: z.literal("chart"),
  title: Title.optional(),
  metric: z.enum(CHART_METRICS),
  days: z.number().int().min(3).max(60).optional(),
  kind: z.enum(["line", "bar"]).optional(),
});

export const ModuleSpecSchema = z.discriminatedUnion("type", [
  DayTimelineSpec,
  WeekViewSpec,
  TaskListSpec,
  OptionsSpec,
  DeadlineHorizonSpec,
  ProjectCardSpec,
  ArtifactPreviewSpec,
  ComparisonTableSpec,
  RuleCardSpec,
  BeliefCardSpec,
  ConfirmationChipsSpec,
  NoteSpec,
  RhythmViewSpec,
  ChartSpec,
]);
export type ModuleSpec = z.infer<typeof ModuleSpecSchema>;
export type ModuleType = ModuleSpec["type"];

export const MODULE_TYPES: ModuleType[] = [
  "day_timeline",
  "week_view",
  "task_list",
  "options",
  "deadline_horizon",
  "project_card",
  "artifact_preview",
  "comparison_table",
  "rule_card",
  "belief_card",
  "confirmation_chips",
  "note",
  "rhythm_view",
  "chart",
];

/** Parse a module spec; returns either the spec or readable errors. */
export function parseModuleSpec(input: unknown): { ok: true; spec: ModuleSpec } | { ok: false; errors: string[] } {
  const r = ModuleSpecSchema.safeParse(input);
  if (r.success) return { ok: true, spec: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}

/** Deep-merge a patch into a spec (arrays replace) for in-place updates. */
export function mergeSpec(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = mergeSpec(base[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hydrated modules (what the app renders)
// ---------------------------------------------------------------------------

export interface TimelineEntry {
  id: string;
  kind: "event" | "wake" | "plan" | "deadline" | "pending_change";
  title: string;
  start: string;
  end: string | null;
  detail?: string;
  item_id?: string;
  wake_id?: string;
  /** For events: class | exam | meeting | other */
  category?: string;
  status?: string;
  movable?: boolean;
  highlighted?: boolean;
}

export interface HydratedItem {
  id: string;
  type: string;
  title: string;
  status: string;
  status_label: string;
  due_at: string | null;
  due_phrase: string | null;
  start_at: string | null;
  project_id: string | null;
  project_title: string | null;
  importance: number | null;
  tags: string[];
  kind: string | null;
  estimate_minutes: number | null;
  touched_at: string;
  days_in_status: number;
  pending_change?: string | null;
}

export type HydratedData =
  | { type: "day_timeline"; date: string; tz: string; entries: TimelineEntry[]; now: string; waking: { start: string; end: string } }
  | { type: "week_view"; days: { date: string; label: string; entries: TimelineEntry[] }[]; tz: string; now: string }
  | { type: "task_list"; items: HydratedItem[] }
  | {
      type: "options";
      prompt: string | null;
      options: { key: string; label: string; detail: string | null; action: OptionAction; chosen?: boolean }[];
      recommended: string | null;
      chosen: string | null;
    }
  | {
      type: "deadline_horizon";
      days: number;
      now: string;
      items: (HydratedItem & { hours_left: number; prep: "not_started" | "started" | "nearly" | "done" })[];
    }
  | {
      type: "project_card";
      project: HydratedItem & { next_step: string | null; important: boolean };
      tasks: HydratedItem[];
      open_loops: HydratedItem[];
      days_since_touched: number;
    }
  | { type: "artifact_preview"; artifact: ArtifactView }
  | { type: "comparison_table"; columns: string[]; rows: { key: string; label: string; cells: string[] }[]; recommended_row: string | null }
  | { type: "rule_card"; rule: import("./rules").RuleView }
  | { type: "belief_card"; beliefs: import("./items").Belief[] }
  | { type: "confirmation_chips"; batch_id: string; proposals: import("./changes").Proposal[] }
  | { type: "note"; paragraphs: string[]; tone: "plain" | "caution" }
  | {
      type: "rhythm_view";
      metric: string;
      days: number;
      /** 24 buckets × 7 weekdays of minutes, Monday first. */
      grid: number[][];
      by_hour: number[];
      summary: string;
      sample_days: number;
    }
  | { type: "chart"; metric: string; kind: "line" | "bar"; unit: string; points: { date: string; value: number }[] };

export interface HydratedModule {
  key: string;
  type: ModuleType;
  title: string;
  spec: ModuleSpec;
  data: HydratedData;
  /** Segment keys in reveal order. */
  segments: string[];
  status: "visible" | "dismissed";
  created_at: string;
  updated_at: string;
  version: number;
}

export interface ArtifactView {
  id: string;
  kind: "practice_set" | "summary" | "draft" | "outline" | "plan";
  title: string;
  item_id: string | null;
  item_title: string | null;
  created_at: string;
  body: ArtifactBody;
  exec_task_id: string | null;
}

export type ArtifactBody =
  | { kind: "practice_set"; intro: string; questions: { q: string; answer: string; hint?: string }[] }
  | { kind: "draft"; to: string | null; subject: string | null; body: string; notes: string | null }
  | { kind: "summary"; sections: { heading: string; text: string }[] }
  | { kind: "outline"; sections: { heading: string; points: string[] }[] }
  | { kind: "plan"; steps: { label: string; minutes: number | null }[]; notes: string | null };

/** Compact one-line summary of a module used in Ava's context every turn. */
export function moduleSummaryLine(m: HydratedModule): string {
  const d = m.data;
  switch (d.type) {
    case "day_timeline":
      return `${m.key}: day timeline for ${d.date}, ${d.entries.length} entries`;
    case "week_view":
      return `${m.key}: week view from ${d.days[0]?.date}`;
    case "task_list":
      return `${m.key}: task list "${m.title}" with ${d.items.length} items (${d.items
        .slice(0, 6)
        .map((i) => `${i.id} ${i.title} [${i.status}]`)
        .join("; ")}${d.items.length > 6 ? "; …" : ""})`;
    case "options":
      return `${m.key}: options (${d.options.map((o) => `${o.key}: ${o.label}`).join(" | ")})${d.chosen ? `, chose ${d.chosen}` : ""}`;
    case "deadline_horizon":
      return `${m.key}: deadline horizon, ${d.items.length} items in ${d.days} days`;
    case "project_card":
      return `${m.key}: project card ${d.project.id} ${d.project.title}`;
    case "artifact_preview":
      return `${m.key}: artifact ${d.artifact.id} (${d.artifact.kind}) "${d.artifact.title}"`;
    case "comparison_table":
      return `${m.key}: comparison of ${d.rows.map((r) => r.label).join(", ")}`;
    case "rule_card":
      return `${m.key}: rule ${d.rule.id} "${d.rule.name}" [${d.rule.status}]`;
    case "belief_card":
      return `${m.key}: beliefs ${d.beliefs.map((b) => b.id).join(", ")}`;
    case "confirmation_chips":
      return `${m.key}: confirmation chips, ${d.proposals.filter((p) => p.status === "pending").length} pending of ${d.proposals.length}`;
    case "note":
      return `${m.key}: note "${m.title}"`;
    case "rhythm_view":
      return `${m.key}: rhythm view of ${d.metric} over ${d.days} days`;
    case "chart":
      return `${m.key}: chart of ${d.metric}`;
  }
}
