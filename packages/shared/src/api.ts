import type { OptionAction, HydratedModule, ArtifactView, HydratedItem } from "./canvas";
import type { ResponseKind } from "./changes";
import type { Item, Belief } from "./items";
import type { RuleView, ShadowResult } from "./rules";

export interface MessageOption {
  key: string;
  label: string;
  action: OptionAction;
}

export interface MessageView {
  id: string;
  kind: "nudge" | "brief" | "alert" | "weekly_review" | "executor_report";
  rule_id: string | null;
  rule_name: string | null;
  headline: string;
  because: string;
  cited: { id: string; title: string; type: string }[];
  options: MessageOption[];
  urgency: "now" | "today" | "brief";
  status: "sent" | "queued" | "blocked" | "in_brief" | "dropped";
  block_reason: string | null;
  created_at: string;
  sent_at: string | null;
  response: ResponseKind | null;
  response_option: string | null;
  responded_at: string | null;
  acted: boolean | null;
  wake_id: string | null;
  drafted_by: "model" | "fallback_template" | "system";
}

export interface WakeView {
  id: string;
  kind: string;
  due_at: string;
  status: "pending" | "running" | "done" | "failed" | "cancelled" | "skipped";
  owner: string;
  reason: string;
  item_ids: string[];
  movable: boolean;
  cancellable: boolean;
  finished_at: string | null;
  outcome: string | null;
}

export interface LogEntry {
  id: number;
  at: string;
  wake_id: string | null;
  kind: string;
  summary: string;
  level: "info" | "warn" | "error";
  data: unknown;
}

export interface ConfigItemReport {
  key: string;
  present: boolean;
  required: boolean;
  secret: boolean;
  description: string;
}

export interface FeatureReport {
  id: string;
  label: string;
  enabled: boolean;
  reason: string | null;
}

export interface ConfigReport {
  profile: "real" | "test";
  items: ConfigItemReport[];
  features: FeatureReport[];
}

export interface PlannedBlock {
  id: string;
  item_id: string | null;
  title: string;
  start_at: string;
  end_at: string;
  note: string | null;
  status: string;
}

export interface QuestionView {
  id: string;
  text: string;
  why: string;
  status: string;
  answer: string | null;
}

export interface BriefView {
  id: string;
  date: string;
  /** Spoken script with cue tokens; the app strips them for display. */
  spoken: string;
  modules: HydratedModule[];
  question: QuestionView | null;
  messages: MessageView[];
  rule_proposals: RuleView[];
  created_at: string;
  audio_id: string | null;
  drafted_by: "model" | "fallback_template" | "system";
}

export interface ExternalActionView {
  id: string;
  kind: "email.send";
  status: "pending" | "confirmed" | "executed" | "cancelled" | "failed";
  /** Exactly what will be sent and to whom. */
  preview: { to: string; subject: string; body: string };
  artifact_id: string | null;
  created_at: string;
  result: string | null;
  available: boolean;
  unavailable_reason: string | null;
}

export interface TurnView {
  id: string;
  role: "user" | "ava";
  mode: "async" | "live";
  text: string;
  input_kind: string | null;
  created_at: string;
  audio_id: string | null;
  cues: { target: string; at_ms: number }[] | null;
  trimmed_affirmation: boolean;
}

export interface CanvasState {
  conversation_id: string;
  modules: HydratedModule[];
  turns: TurnView[];
}

export interface ExecTaskView {
  id: string;
  kind: string;
  title: string;
  status: string;
  item_id: string | null;
  sessions_run: number;
  max_sessions: number;
  progress_note: string | null;
  plan_fit: { fits: boolean; note: string } | null;
  artifacts: ArtifactView[];
  created_at: string;
  updated_at: string;
}

export interface SourceView {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  default_on: boolean;
  configured: boolean;
  needs: string | null;
  connected: boolean;
  last_sync_at: string | null;
  last_error: string | null;
  stats: Record<string, number>;
}

export interface KnowsView {
  beliefs: Belief[];
  proposed: Belief[];
  areas: string[];
}

export interface TasksView {
  items: Item[];
  projects: Item[];
}

export interface LatencySample {
  id: string;
  at: string;
  mode: "live" | "async";
  model: string;
  tts: string;
  stt: string;
  stages: Record<string, number>;
  total_ms: number | null;
}

export interface UsageView {
  date: string;
  calls_system: number;
  calls_interactive: number;
  cost_usd: number;
  budget: { system_calls: number; interactive_calls: number; usd: number };
  by_purpose: { purpose: string; calls: number; cost_usd: number; avg_ms: number }[];
  recent: { id: string; at: string; purpose: string; model: string; ms: number; cost_usd: number; status: string; cache_read: number }[];
}

// ---------------------------------------------------------------------------
// Threads, cards and the stack
// ---------------------------------------------------------------------------

/** A thread: one top-level area of his life right now ("Midterm week", "Finish the SOP"). */
export interface ThreadNode {
  id: string;
  title: string;
  open_count: number;
  /** Threads Ava grouped under this one to keep the top level short. */
  children: ThreadNode[];
  items: (HydratedItem & { subtasks: HydratedItem[] })[];
}

/** Do: an action. Pick: a decision between 2 to 4 options. Know: a heads-up that needs nothing. */
export type CardKind = "do" | "pick" | "know";

export interface CardOption {
  key: string;
  label: string;
  detail: string | null;
  /** True when choosing it starts preparatory work (an executor session). */
  work: boolean;
}

/** Layer 1: one line saying what it is, and a short "why now". */
export interface CardView {
  id: string;
  kind: CardKind;
  title: string;
  why: string | null;
  thread: { id: string; title: string } | null;
  /** The first option is what "yes" does. */
  options: CardOption[];
  time_sensitive: boolean;
  /** How many times he has said "not now" to it. */
  returns: number;
  /** Whether "already done" means anything for this card (it is about real items). */
  has_items: boolean;
  /** Whether there is a third layer to open: the work itself or full detail. */
  deeper: boolean;
  created_at: string;
}

export interface FiledEntry {
  proposal_id: string;
  summary: string;
  status: "filed" | "undone" | "needs_you";
}

/** Layer 2: the thread's few relevant parts, the options in detail, or what was filed. */
export interface CardLayer2 {
  card_id: string;
  parts: HydratedItem[];
  options: CardOption[];
  filed: FiledEntry[];
  paragraphs: string[];
  shadow: ShadowResult | null;
}

/** Layer 3: the work itself or the full detail. */
export interface CardLayer3 {
  card_id: string;
  artifact: ArtifactView | null;
  action: ExternalActionView | null;
  paragraphs: string[];
  /** Why Ava brought it up: the rule and its evidence. */
  rule: { name: string; sentence: string; evidence: string | null } | null;
  items: HydratedItem[];
}

export type CardResponse = "yes" | "not_now" | "already_done" | "stop";

export interface CardResult {
  card: CardView;
  summary: string;
  /** For the client: open the confirm-send sheet or an artifact. */
  open: { kind: "action"; id: string } | { kind: "artifact"; id: string } | null;
  exec_task_id: string | null;
  returns_at: string | null;
}

export interface StackView {
  cards: CardView[];
  all_clear: { next_check_in: WakeView | null } | null;
  /** The optional spoken morning version: a few sentences pointing at the cards. */
  morning: { brief_id: string; text: string } | null;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

/** One event, as the calendar view shows it. */
export interface CalendarEventView {
  id: string;
  title: string;
  start: string;
  end: string | null;
  all_day: boolean;
  /** class | exam | meeting | social | other */
  category: string | null;
  location: string | null;
}

/** One day: his calendar and Ava's planned check-ins, nothing else. */
export interface CalendarDayView {
  date: string;
  events: CalendarEventView[];
  check_ins: WakeView[];
}

export interface CalendarView {
  tz: string;
  now: string;
  days: CalendarDayView[];
}
