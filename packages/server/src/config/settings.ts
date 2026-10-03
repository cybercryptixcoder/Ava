import { z } from "zod";
import { DEFAULT_LOCATIONS, TONES } from "@ava/shared";

/**
 * Runtime-tunable settings. Defaults live here; overrides are stored in the
 * settings table and edited from the Settings screen. Every number in the
 * brief that is described as a "default" is one of these.
 *
 * Constitutional limits are enforced in code elsewhere and are NOT settings
 * a dynamic rule can touch (see constitution.ts).
 */
const LocalTime = z.string().regex(/^\d{1,2}:\d{2}$/);

const VoiceChoice = z.object({
  provider: z.enum(["elevenlabs", "cartesia"]),
  model: z.string(),
  voice_id: z.string(),
});

export const SettingsSchema = z.object({
  locations: z.array(z.object({ id: z.string(), label: z.string(), tz: z.string() })).min(1),
  current_location_id: z.string(),
  quiet_hours: z.object({ start: LocalTime, end: LocalTime }),
  caps: z.object({ unprompted_per_day: z.number().int().min(0).max(20), max_per_wake: z.number().int().min(1).max(3) }),
  budgets: z.object({
    system_calls: z.number().int().min(0),
    interactive_calls: z.number().int().min(0),
    usd: z.number().min(0),
  }),
  heartbeat_every_hours: z.number().min(1).max(12),
  brief_time: LocalTime,
  evening_time: LocalTime,
  weekly_review: z.object({ weekday: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]), time: LocalTime }),
  deadline_offsets_days: z.array(z.number().int().min(0).max(60)).min(1),
  deadline_wake_time: LocalTime,
  deadman_waking_hours: z.number().min(1).max(48),
  wake_budget: z.object({
    total_per_day: z.number().int().min(1),
    planner_requests_per_day: z.number().int().min(0),
    rule_wakes_per_day: z.number().int().min(0),
    executor_sessions_per_day: z.number().int().min(0),
    min_gap_minutes: z.number().int().min(1),
    horizon_days: z.number().int().min(1).max(30),
    new_context_planning_per_day: z.number().int().min(0),
  }),
  rules: z.object({
    finish_line_days: z.number().min(0.5),
    stale_project_days: z.number().min(1),
    free_block_min_minutes: z.number().int().min(15),
    free_block_lead_minutes: z.number().int().min(1),
    self_pause_precision: z.number().min(0).max(1),
    self_pause_min_messages: z.number().int().min(1),
    max_new_per_week: z.number().int().min(0),
    max_active_dynamic: z.number().int().min(0),
    default_expiry_days: z.number().int().min(1),
    default_cooldown_hours: z.number().min(1),
    less_of_this_cooldown_days: z.number().min(0.5),
    shadow_days: z.number().int().min(1).max(14),
  }),
  stack: z.object({
    /** How many cards the stack shows at once on a normal day. */
    max_cards: z.number().int().min(1).max(12),
    /** "Not now" brings a card back no sooner than this. */
    min_return_minutes: z.number().int().min(15),
    /** Rule approvals that can message him surface as a card at most this often. */
    rule_card_every_days: z.number().min(1),
    /** Unconfirmed inferences surface as a card at most this often. */
    belief_card_every_days: z.number().min(1),
  }),
  threads: z.object({
    /** Top-level threads before Ava groups further. */
    max_active: z.number().int().min(2).max(20),
  }),
  notifications: z.object({
    /** Push notifications for time-sensitive cards per day. Everything else waits in the stack. */
    push_per_day: z.number().int().min(0).max(10),
  }),
  approval: z.object({
    /** Rules that only wake or prepare work silently auto-approve within budget. */
    auto_approve_internal: z.boolean(),
  }),
  conversation: z.object({
    affirmation_window: z.number().int().min(1),
    affirmation_max: z.number().int().min(0),
    affirmation_model_check: z.boolean(),
  }),
  voice: z.object({
    autoplay: z.boolean(),
    async_voice: VoiceChoice,
    live_voice: VoiceChoice,
    stt_provider: z.enum(["deepgram", "assemblyai"]),
    /** 0 = quick to respond, 1 = very patient with pauses. */
    turn_patience: z.number().min(0).max(1),
    vocabulary: z.array(z.string()).max(100),
    live_model: z.string(),
    pronunciations: z.array(z.object({ text: z.string(), say: z.string() })),
    allowed_tones: z.array(z.enum(TONES)),
  }),
  sources: z.record(z.string(), z.boolean()),
  retention: z.object({
    raw_activity_days: z.number().min(0.5),
    raw_audio_days: z.number().min(0.5),
    model_io_days: z.number().min(1),
    snapshots_days: z.number().min(1),
  }),
  executor: z.object({ max_sessions: z.number().int().min(1).max(20), session_spacing_minutes: z.number().int().min(5) }),
  beliefs: z.object({ half_life_days: z.number().min(1), inferred_min_confidence: z.number().min(0).max(1) }),
  memory: z.object({
    /** The core (L3) block's budget, in tokens. */
    core_budget_tokens: z.number().int().min(200).max(4000),
    /** The retrieved context pack's budget, in tokens. */
    context_budget_tokens: z.number().int().min(500).max(20000),
    /** Recent window: the last N turns of the current conversation. */
    recent_turns: z.number().int().min(2).max(30),
    /** The recent window's token cap, whichever is smaller wins. */
    recent_budget_tokens: z.number().int().min(500).max(8000),
    /** Ranking: weighted mix of relevance, recency (exponential decay) and importance. */
    ranking: z.object({
      relevance: z.number().min(0).max(5),
      recency: z.number().min(0).max(5),
      importance: z.number().min(0).max(5),
      /** How much semantic (embedding) similarity adds to keyword relevance. */
      semantic: z.number().min(0).max(5),
      half_life_days: z.number().min(1).max(365),
    }),
    /** Semantic search provider: auto picks local, then hosted, then the built-in lexical fallback. */
    embeddings: z.object({ provider: z.enum(["auto", "local", "hosted", "lexical"]) }),
    /** Skip retrieval entirely for messages that clearly need no memory. */
    fast_path: z.boolean(),
    /** The retriever runs as a cheap-model sub-agent; "direct" skips the agent. */
    retriever: z.object({ mode: z.enum(["agent", "direct"]), max_rounds: z.number().int().min(1).max(8) }),
  }),
  first_run_complete: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export function defaultSettings(envDefaults: {
  budgetSystem: number;
  budgetInteractive: number;
  budgetUsd: number;
  liveModel: string;
  elevenVoice?: string;
  cartesiaVoice?: string;
}): Settings {
  const elevenVoice = envDefaults.elevenVoice ?? "";
  return {
    locations: DEFAULT_LOCATIONS,
    current_location_id: "state-college",
    quiet_hours: { start: "23:00", end: "08:00" },
    caps: { unprompted_per_day: 3, max_per_wake: 1 },
    budgets: { system_calls: envDefaults.budgetSystem, interactive_calls: envDefaults.budgetInteractive, usd: envDefaults.budgetUsd },
    heartbeat_every_hours: 3,
    brief_time: "08:30",
    evening_time: "21:30",
    weekly_review: { weekday: "sun", time: "18:00" },
    deadline_offsets_days: [14, 3, 1],
    deadline_wake_time: "10:00",
    deadman_waking_hours: 6,
    wake_budget: {
      total_per_day: 30,
      planner_requests_per_day: 8,
      rule_wakes_per_day: 6,
      executor_sessions_per_day: 12,
      min_gap_minutes: 15,
      horizon_days: 7,
      new_context_planning_per_day: 2,
    },
    rules: {
      finish_line_days: 2,
      stale_project_days: 7,
      free_block_min_minutes: 60,
      free_block_lead_minutes: 15,
      self_pause_precision: 0.4,
      self_pause_min_messages: 5,
      max_new_per_week: 3,
      max_active_dynamic: 15,
      default_expiry_days: 14,
      default_cooldown_hours: 20,
      less_of_this_cooldown_days: 3,
      shadow_days: 3,
    },
    stack: { max_cards: 5, min_return_minutes: 180, rule_card_every_days: 7, belief_card_every_days: 4 },
    threads: { max_active: 7 },
    notifications: { push_per_day: 2 },
    approval: { auto_approve_internal: true },
    conversation: { affirmation_window: 10, affirmation_max: 1, affirmation_model_check: true },
    voice: {
      autoplay: true,
      async_voice: { provider: "elevenlabs", model: "eleven_v3", voice_id: elevenVoice },
      live_voice: { provider: "elevenlabs", model: "eleven_flash_v2_5", voice_id: elevenVoice },
      stt_provider: "deepgram",
      turn_patience: 0.65,
      vocabulary: [],
      live_model: envDefaults.liveModel,
      pronunciations: [],
      allowed_tones: ["gentler", "lighter", "serious"],
    },
    sources: {
      voice: true,
      manual: true,
      gcal: true,
      ics: true,
      chat_import: true,
      gmail: false,
      activity: false,
      saved_items: false,
      wispr: false,
    },
    retention: { raw_activity_days: 3, raw_audio_days: 7, model_io_days: 30, snapshots_days: 14 },
    executor: { max_sessions: 6, session_spacing_minutes: 20 },
    beliefs: { half_life_days: 45, inferred_min_confidence: 0.5 },
    memory: {
      core_budget_tokens: 1500,
      context_budget_tokens: 6000,
      recent_turns: 10,
      recent_budget_tokens: 3000,
      ranking: { relevance: 1, recency: 0.35, importance: 0.25, semantic: 0.5, half_life_days: 30 },
      embeddings: { provider: "auto" },
      fast_path: true,
      retriever: { mode: "agent", max_rounds: 4 },
    },
    first_run_complete: false,
  };
}
