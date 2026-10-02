import type { OptionAction, HydratedModule, ArtifactView } from "./canvas";
import type { ResponseKind, Proposal } from "./changes";
import type { Item, Belief } from "./items";
import type { RuleView } from "./rules";

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

export interface TodayView {
  now: string;
  tz: string;
  location_id: string;
  date: string;
  timeline: HydratedModule;
  waiting: {
    messages: MessageView[];
    proposals: Proposal[];
    rule_proposals: RuleView[];
    external_actions: ExternalActionView[];
    question: QuestionView | null;
  };
  next_wake: WakeView | null;
  brief: BriefView | null;
  plan_note: string | null;
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
  drafted_by: "model" | "fallback_template";
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
