import type { AppConfig } from "../config/config";
import type { Db } from "../db/db";
import type { Clock } from "./clock";
import type { Cipher } from "../security/crypto";
import type { DecisionLog } from "./log";
import type { EventBus } from "./events";
import type { Counters, SettingsStore } from "./settings-store";
import type { ItemStore } from "../state/items";
import type { EvidenceStore } from "../state/evidence";
import type { MemoryStore } from "../state/memory";
import type { Backfill } from "../memory/backfill";
import type { MemoryProcessor } from "../memory/processor";
import type { MemorySearch } from "../memory/search";
import type { Retriever } from "../memory/retriever";
import type { Embeddings } from "../memory/embeddings";
import type { BeliefStore } from "../state/beliefs";
import type { ProposalStore } from "../state/proposals";
import type { QuestionStore } from "../state/questions";
import type { ModelGateway } from "../models/gateway";
import type { Personality } from "../personality/personality";
import type { RuleStore } from "../rules/store";
import type { RuleEngine } from "../rules/engine";
import type { Scheduler } from "../scheduler/scheduler";
import type { MessageStore } from "../messages/store";
import type { Responder } from "../messages/responder";
import type { ChannelHub } from "../channels/hub";
import type { Executors } from "../executors/executors";
import type { Planner } from "../planner/planner";
import type { BriefComposer } from "../planner/brief";
import type { Canvas } from "../canvas/canvas";
import type { Conversation } from "../conversation/conversation";
import type { SourceHub } from "../sources/hub";
import type { VoiceHub } from "../voice/hub";
import type { ExternalActions } from "../actions/external";
import type { OptionRunner } from "../actions/options";
import type { WakeProcedure } from "../wake/procedure";
import type { AudioStore } from "../voice/audio-store";
import type { Rhythms } from "../state/rhythms";
import type { ThreadStore } from "../state/threads";
import type { Filing } from "../state/filing";
import type { CardStore } from "../cards/cards";

/** Everything a module may need. Built once in app.ts; tests build it with fakes for external services. */
export interface Services {
  cfg: AppConfig;
  db: Db;
  clock: Clock;
  cipher: Cipher;
  log: DecisionLog;
  bus: EventBus;
  settings: SettingsStore;
  counters: Counters;
  items: ItemStore;
  evidence: EvidenceStore;
  /** L0, the raw log. Everything derived points back into it. */
  memory: MemoryStore;
  /** One-time resumable migration of existing data into the raw log. */
  backfill: Backfill;
  /** Builds episodes, gists and fact keys from uncovered raw entries. */
  memoryProcessor: MemoryProcessor;
  /** In-memory (from decrypted rows) keyword index over the log and its layers. */
  memorySearch: MemorySearch;
  /** Assembles the context pack for a message (agent or direct). */
  retriever: Retriever;
  /** Embeddings behind an adapter: local default, optional hosted, lexical fallback. */
  embeddings: Embeddings;
  beliefs: BeliefStore;
  proposals: ProposalStore;
  threads: ThreadStore;
  filing: Filing;
  cards: CardStore;
  questions: QuestionStore;
  rhythms: Rhythms;
  models: ModelGateway;
  personality: Personality;
  rules: RuleStore;
  engine: RuleEngine;
  scheduler: Scheduler;
  messages: MessageStore;
  responder: Responder;
  channels: ChannelHub;
  executors: Executors;
  planner: Planner;
  brief: BriefComposer;
  canvas: Canvas;
  conversation: Conversation;
  sources: SourceHub;
  voice: VoiceHub;
  audio: AudioStore;
  actions: ExternalActions;
  options: OptionRunner;
  wake: WakeProcedure;
}
