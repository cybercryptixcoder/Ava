import { isClosed } from "@ava/shared";
import { loadConfig, type AppConfig } from "./config/config";
import { defaultSettings } from "./config/settings";
import { Db } from "./db/db";
import { RealClock, SimClock, type Clock } from "./core/clock";
import { EventBus } from "./core/events";
import { DecisionLog } from "./core/log";
import { Counters, SettingsStore } from "./core/settings-store";
import type { Services } from "./core/services";
import { Cipher } from "./security/crypto";
import { ItemStore } from "./state/items";
import { EvidenceStore } from "./state/evidence";
import { MemoryStore } from "./state/memory";
import { Backfill } from "./memory/backfill";
import { MemoryProcessor } from "./memory/processor";
import { MemorySearch } from "./memory/search";
import { Retriever } from "./memory/retriever";
import { Embeddings } from "./memory/embeddings";
import { Core } from "./memory/core";
import { BeliefStore } from "./state/beliefs";
import { ProposalStore } from "./state/proposals";
import { QuestionStore } from "./state/questions";
import { Rhythms } from "./state/rhythms";
import { ThreadStore } from "./state/threads";
import { Filing } from "./state/filing";
import { CardStore } from "./cards/cards";
import { ModelGateway } from "./models/gateway";
import { AnthropicProvider } from "./models/anthropic";
import type { ModelProvider } from "./models/types";
import { Personality } from "./personality/personality";
import { RuleStore } from "./rules/store";
import { RuleEngine } from "./rules/engine";
import { Scheduler } from "./scheduler/scheduler";
import { DeadmanSwitch } from "./scheduler/deadman";
import { MessageStore } from "./messages/store";
import { Responder } from "./messages/responder";
import { ChannelHub } from "./channels/hub";
import { Executors } from "./executors/executors";
import { Planner } from "./planner/planner";
import { BriefComposer } from "./planner/brief";
import { Canvas } from "./canvas/canvas";
import { Conversation } from "./conversation/conversation";
import { SourceHub } from "./sources/hub";
import { VoiceHub } from "./voice/hub";
import { AudioStore } from "./voice/audio-store";
import { ExternalActions } from "./actions/external";
import { OptionRunner } from "./actions/options";
import { WakeProcedure } from "./wake/procedure";
import { runRetention } from "./core/retention";

export interface App {
  svc: Services;
  deadman: DeadmanSwitch;
  start(): void;
  stop(): void;
}

export interface BuildOptions {
  config?: Partial<AppConfig>;
  /** Override the model transport (tests use a scripted one). */
  provider?: ModelProvider | null;
  clock?: Clock;
  dbFile?: string;
}

/**
 * Build the whole system. Order matters only where constructors read other
 * services; everything else is late-bound through the Services object.
 */
export function buildApp(opts: BuildOptions = {}): App {
  const cfg = loadConfig(opts.config ?? {});
  const db = new Db(opts.dbFile ?? cfg.dbFile);
  const clock: Clock = opts.clock ?? (cfg.profile === "test" ? new SimClock(new Date()) : new RealClock());
  const cipher = new Cipher(cfg.encryptionKey);
  const bus = new EventBus();
  const log = new DecisionLog(db, clock, bus);
  const settings = new SettingsStore(
    db,
    defaultSettings({
      budgetSystem: cfg.budgets.system,
      budgetInteractive: cfg.budgets.interactive,
      budgetUsd: cfg.budgets.usd,
      liveModel: cfg.models.live,
      elevenVoice: cfg.elevenlabs.voiceId ?? (cfg.cartesia.voiceId && !cfg.elevenlabs.key ? undefined : undefined),
    }),
  );
  const counters = new Counters(db, clock, () => settings.tz());

  const svc = { cfg, db, clock, cipher, bus, log, settings, counters } as Services;
  svc.memory = new MemoryStore(db, clock, cipher);
  svc.items = new ItemStore(db, clock, svc.memory);
  svc.evidence = new EvidenceStore(db, clock, cipher);
  svc.beliefs = new BeliefStore(db, clock, () => settings.get().beliefs.half_life_days);
  svc.threads = new ThreadStore(db, clock, svc.items, settings, log);
  svc.proposals = new ProposalStore(db, clock, svc.items, svc.beliefs, svc.evidence, log, svc.threads);
  svc.filing = new Filing(svc);
  svc.cards = new CardStore(svc);
  svc.questions = new QuestionStore(svc);
  svc.rhythms = new Rhythms(svc);
  const provider = opts.provider !== undefined ? opts.provider : cfg.anthropicKey ? new AnthropicProvider(cfg.anthropicKey, cfg.refusalFallback) : null;
  svc.models = new ModelGateway(provider, db, clock, cipher, counters, settings, log);
  svc.personality = new Personality(cfg.personalityDir);
  svc.rules = new RuleStore(db, clock, settings, log);
  svc.engine = new RuleEngine(db, clock, svc.items, svc.rules, settings, counters, log, () => svc.rhythms.activityNow());
  svc.scheduler = new Scheduler(db, clock, settings, counters, svc.items, log, bus);
  svc.messages = new MessageStore(db, clock, svc.items, svc.rules);
  svc.channels = new ChannelHub(svc);
  svc.responder = new Responder(svc);
  svc.executors = new Executors(svc);
  svc.planner = new Planner(svc);
  svc.brief = new BriefComposer(svc);
  svc.canvas = new Canvas(svc);
  svc.conversation = new Conversation(svc);
  svc.sources = new SourceHub(svc);
  svc.audio = new AudioStore(svc);
  svc.voice = new VoiceHub(svc);
  svc.actions = new ExternalActions(svc);
  svc.options = new OptionRunner(svc);
  svc.wake = new WakeProcedure(svc);
  svc.backfill = new Backfill(svc);
  svc.memoryProcessor = new MemoryProcessor(svc);
  svc.memorySearch = new MemorySearch(svc);
  svc.retriever = new Retriever(svc);
  svc.embeddings = new Embeddings(svc);
  svc.core = new Core(svc);
  // The derived layers watch the log: every append schedules processing.
  svc.memory.onAppend(() => svc.memoryProcessor.notify());
  svc.memory.onAppend((e) => svc.memorySearch.indexEntry(e));
  svc.memory.onForget((ids) => {
    for (const id of ids) {
      svc.memorySearch.removeRef("entry", id);
      svc.embeddings.remove("entry", id);
    }
  });

  // Default voices from env if not chosen yet.
  const v = settings.get().voice;
  if (!v.async_voice.voice_id && !v.live_voice.voice_id) {
    if (cfg.elevenlabs.key && cfg.elevenlabs.voiceId) {
      settings.update({ voice: { ...v, async_voice: { provider: "elevenlabs", model: "eleven_v3", voice_id: cfg.elevenlabs.voiceId }, live_voice: { provider: "elevenlabs", model: "eleven_flash_v2_5", voice_id: cfg.elevenlabs.voiceId } } }, clock.now());
    } else if (cfg.cartesia.key && cfg.cartesia.voiceId) {
      settings.update({ voice: { ...v, async_voice: { provider: "cartesia", model: "sonic-3.5", voice_id: cfg.cartesia.voiceId }, live_voice: { provider: "cartesia", model: "sonic-3.5", voice_id: cfg.cartesia.voiceId } } }, clock.now());
    }
  }

  svc.proposals.answerQuestion = (id, answer) => void svc.questions.answer(id, answer);
  svc.rules.seedBuiltins();

  // Item changes: deadlines get wakes; completions cancel related wakes and count as acting on nudges;
  // genuinely new projects trigger a planning session; any change is an event wake.
  svc.items.onChange((c) => {
    const it = c.item;
    // Every task, deadline, commitment and open loop lives in a thread.
    if (c.kind === "created" && !it.thread_id && svc.threads.threadable(it)) {
      svc.threads.place(it);
      svc.threads.enforceCap();
    }
    if (["task", "commitment"].includes(it.type) && (c.kind === "created" || c.before?.due_at !== it.due_at || c.kind === "completed" || c.kind === "status")) {
      svc.scheduler.syncDeadlineWakes(it);
    }
    if (c.kind === "completed" || c.kind === "deleted" || (it && isClosed(it.type, it.status))) {
      const n = svc.scheduler.cancelForItem(it.id, `${it.title} is ${c.kind === "deleted" ? "removed" : "done"}`);
      if (n) log.info("schedule.item_closed", `${it.title} closed: cancelled ${n} related wake${n === 1 ? "" : "s"}`);
      svc.proposals.supersedePendingFor(it.id);
      svc.cards.closeForItem(it.id);
    }
    if (c.kind === "completed" || c.kind === "status") svc.messages.markActedFromItem(it.id);
    if (c.kind === "created" && it.type === "project" && !c.via.startsWith("chip:chat_import") && c.via !== "seed") {
      svc.planner.requestNewContext(`a new project, "${it.title}"`);
    }
    if (!["gcal", "rhythms", "seed", "undo"].includes(c.via) && !c.via.startsWith("ics:") && it.type !== "event") {
      svc.scheduler.event(`${it.title}: ${c.kind}`, [it.id]);
    }
    bus.emit({ type: "state.changed", what: ["items"] });
  });

  settings.onChange((s, prev) => {
    if (s.current_location_id !== prev.current_location_id || s.quiet_hours.start !== prev.quiet_hours.start || s.quiet_hours.end !== prev.quiet_hours.end || s.brief_time !== prev.brief_time || s.evening_time !== prev.evening_time || s.heartbeat_every_hours !== prev.heartbeat_every_hours || JSON.stringify(s.weekly_review) !== JSON.stringify(prev.weekly_review) || s.deadline_wake_time !== prev.deadline_wake_time) {
      const prevTz = prev.locations.find((l) => l.id === prev.current_location_id)?.tz ?? "";
      svc.scheduler.recomputeForTimezone(prevTz);
    }
  });

  const deadman = new DeadmanSwitch(svc);
  svc.scheduler.runner = async (w) => {
    const r = await svc.wake.run(w);
    // Wakes are also a retry moment for anything the log watcher couldn't finish.
    svc.memoryProcessor.notify();
    return r;
  };
  svc.scheduler.afterTick = async () => {
    await deadman.check();
  };

  let retentionTimer: NodeJS.Timeout | null = null;
  return {
    svc,
    deadman,
    start() {
      svc.scheduler.ensureSystemWakes();
      for (const it of svc.items.list({ open: true, types: ["task", "commitment"] })) if (it.due_at) svc.scheduler.syncDeadlineWakes(it);
      svc.threads.backfill();
      // Bring any data from before the raw log existed into it; small batches, resumable.
      svc.backfill.kick();
      // And start the derived layers on anything waiting.
      svc.memoryProcessor.notify();
      svc.scheduler.start();
      deadman.start();
      runRetention(svc);
      if (!clock.simulated) {
        retentionTimer = setInterval(() => runRetention(svc), 6 * 3_600_000);
        retentionTimer.unref?.();
      }
      log.info("system.start", `Ava started (${cfg.profile} profile, ${clock.simulated ? "simulated" : "real"} clock)`);
    },
    stop() {
      svc.scheduler.stop();
      deadman.stop();
      if (retentionTimer) clearInterval(retentionTimer);
      db.close();
    },
  };
}
