import { z } from "zod";

/**
 * The life model's structured items. Every item shares the same envelope
 * (id, type, title, status, temporal fields, tags, importance) and keeps
 * type-specific fields in `data`. New item types are added by registering a
 * definition in ITEM_TYPES; nothing else in the schema has to change.
 */

export const ItemTypeSchema = z.enum([
  "task",
  "project",
  "commitment",
  "open_loop",
  "event",
  "goal",
  "rhythm",
  "preference",
  "saved_item",
]);
export type ItemType = z.infer<typeof ItemTypeSchema>;

export interface ItemTypeDef {
  type: ItemType;
  label: string;
  plural: string;
  /** Allowed statuses, first is the default. */
  statuses: readonly string[];
  /** Statuses that mean "nothing left to do". */
  closed: readonly string[];
  idPrefix: string;
  data: z.ZodType<Record<string, unknown>>;
}

const TaskData = z
  .object({
    /** quiz | exam | assignment | deadline | reading | errand | other */
    kind: z.string().optional(),
    estimate_minutes: z.number().int().positive().optional(),
    course: z.string().optional(),
    notes: z.string().optional(),
    snoozed_until: z.string().optional(),
  })
  .passthrough();

const ProjectData = z
  .object({
    important: z.boolean().optional(),
    next_step: z.string().optional(),
    notes: z.string().optional(),
  })
  .passthrough();

const CommitmentData = z
  .object({
    to_person: z.string().optional(),
    channel: z.string().optional(),
    promised_at: z.string().optional(),
    quote: z.string().optional(),
  })
  .passthrough();

const OpenLoopData = z
  .object({
    /** started | reply_owed | promise */
    kind: z.string().optional(),
    counterpart: z.string().optional(),
  })
  .passthrough();

const EventData = z
  .object({
    /** class | exam | meeting | social | other */
    kind: z.string().optional(),
    location: z.string().optional(),
    calendar: z.string().optional(),
    all_day: z.boolean().optional(),
    busy: z.boolean().optional(),
  })
  .passthrough();

const GoalData = z.object({ horizon: z.string().optional(), why: z.string().optional() }).passthrough();
const RhythmData = z.object({ metric: z.string().optional() }).passthrough();
const PreferenceData = z.object({ key: z.string().optional(), value: z.unknown().optional() }).passthrough();
const SavedItemData = z
  .object({
    url: z.string().optional(),
    platform: z.string().optional(),
    saved_at: z.string().optional(),
    estimate_minutes: z.number().optional(),
  })
  .passthrough();

export const ITEM_TYPES: Record<ItemType, ItemTypeDef> = {
  task: {
    type: "task",
    label: "Task",
    plural: "Tasks",
    statuses: ["todo", "started", "drafted", "almost_done", "done", "dropped"],
    closed: ["done", "dropped"],
    idPrefix: "tsk",
    data: TaskData,
  },
  project: {
    type: "project",
    label: "Project",
    plural: "Projects",
    statuses: ["active", "paused", "done", "dropped"],
    closed: ["done", "dropped"],
    idPrefix: "prj",
    data: ProjectData,
  },
  commitment: {
    type: "commitment",
    label: "Commitment",
    plural: "Commitments",
    statuses: ["open", "done", "dropped"],
    closed: ["done", "dropped"],
    idPrefix: "cmt",
    data: CommitmentData,
  },
  open_loop: {
    type: "open_loop",
    label: "Open loop",
    plural: "Open loops",
    statuses: ["open", "closed"],
    closed: ["closed"],
    idPrefix: "lop",
    data: OpenLoopData,
  },
  event: {
    type: "event",
    label: "Calendar event",
    plural: "Calendar events",
    statuses: ["confirmed", "tentative", "cancelled"],
    closed: ["cancelled"],
    idPrefix: "evt",
    data: EventData,
  },
  goal: {
    type: "goal",
    label: "Goal",
    plural: "Goals",
    statuses: ["active", "achieved", "dropped"],
    closed: ["achieved", "dropped"],
    idPrefix: "gol",
    data: GoalData,
  },
  rhythm: {
    type: "rhythm",
    label: "Rhythm",
    plural: "Rhythms",
    statuses: ["current", "stale"],
    closed: [],
    idPrefix: "rhy",
    data: RhythmData,
  },
  preference: {
    type: "preference",
    label: "Preference",
    plural: "Preferences",
    statuses: ["active", "retired"],
    closed: ["retired"],
    idPrefix: "prf",
    data: PreferenceData,
  },
  saved_item: {
    type: "saved_item",
    label: "Saved item",
    plural: "Saved items",
    statuses: ["unread", "done", "dropped"],
    closed: ["done", "dropped"],
    idPrefix: "sav",
    data: SavedItemData,
  },
};

export const TASK_STATUS_LABEL: Record<string, string> = {
  todo: "Not started",
  started: "Started",
  drafted: "Drafted",
  almost_done: "Almost done",
  done: "Done",
  dropped: "Dropped",
  open: "Open",
  closed: "Closed",
  active: "Active",
  paused: "Paused",
  achieved: "Achieved",
  unread: "Not looked at",
  confirmed: "Confirmed",
  tentative: "Tentative",
  cancelled: "Cancelled",
};

export function statusLabel(status: string | null | undefined): string {
  if (!status) return "";
  return TASK_STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}

export function isClosed(type: ItemType, status: string | null | undefined): boolean {
  return !!status && ITEM_TYPES[type].closed.includes(status);
}

export const ItemSchema = z.object({
  id: z.string(),
  type: ItemTypeSchema,
  title: z.string().min(1),
  status: z.string(),
  data: z.record(z.string(), z.unknown()),
  due_at: z.string().nullable(),
  start_at: z.string().nullable(),
  end_at: z.string().nullable(),
  project_id: z.string().nullable(),
  /** The thread (top-level area of his life right now) Ava filed it under. */
  thread_id: z.string().nullable(),
  /** For subtasks: the task it belongs to. */
  parent_id: z.string().nullable(),
  importance: z.number().int().min(0).max(3).nullable(),
  tags: z.array(z.string()),
  source: z.string(),
  source_ref: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  touched_at: z.string(),
  status_changed_at: z.string(),
  completed_at: z.string().nullable(),
});
export type Item = z.infer<typeof ItemSchema>;

/** Fields a person or the extraction model may set when creating an item. */
export const ItemDraftSchema = z.object({
  type: ItemTypeSchema,
  title: z.string().min(1).max(300),
  status: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  due_at: z.string().nullable().optional(),
  start_at: z.string().nullable().optional(),
  end_at: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  thread_id: z.string().nullable().optional(),
  parent_id: z.string().nullable().optional(),
  importance: z.number().int().min(0).max(3).nullable().optional(),
  tags: z.array(z.string()).optional(),
});
export type ItemDraft = z.infer<typeof ItemDraftSchema>;

export const ItemPatchSchema = ItemDraftSchema.partial().omit({ type: true });
export type ItemPatch = z.infer<typeof ItemPatchSchema>;

/** Beliefs: what Ava thinks is true, kept apart from raw evidence. */
export const ProvenanceSchema = z.enum(["stated", "observed", "inferred"]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const BeliefSchema = z.object({
  id: z.string(),
  area: z.string(),
  statement: z.string(),
  subject_item_id: z.string().nullable(),
  provenance: ProvenanceSchema,
  confidence: z.number().min(0).max(1),
  /** Confidence after decay, computed at read time. */
  effective_confidence: z.number().min(0).max(1),
  status: z.enum(["active", "proposed", "rejected", "retired"]),
  last_confirmed_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  evidence_ids: z.array(z.string()),
});
export type Belief = z.infer<typeof BeliefSchema>;

export const BELIEF_AREAS = [
  "study",
  "work",
  "projects",
  "health",
  "people",
  "routines",
  "interests",
  "goals",
  "preferences",
  "logistics",
] as const;
