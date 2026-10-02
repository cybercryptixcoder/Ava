import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelRequest<T = unknown> {
  /** What the call is for, e.g. "wake.rank", "planner.evening", "conversation". Shown in the log and usage panel. */
  purpose: string;
  /** "system" calls are ones Ava starts on her own; "interactive" ones are started by Shreyas. Budgeted separately. */
  origin: "system" | "interactive";
  model: string;
  /** Stable instructions first (cached), volatile context later in messages. */
  system: string | { text: string; cache?: boolean }[];
  messages: Anthropic.MessageParam[];
  maxTokens: number;
  effort?: Effort;
  /** Live mode turns thinking down to between_tools on Sonnet 5.5 for latency. */
  lowLatency?: boolean;
  schema?: z.ZodType<T>;
  tools?: Anthropic.Tool[];
  wakeId?: string | null;
  signal?: AbortSignal;
  /** Cache the whole prefix including messages (multi-turn conversations). */
  cacheMessages?: boolean;
}

export interface ModelResult<T = unknown> {
  callId: string;
  text: string;
  parsed: T | null;
  parseError: string | null;
  toolUses: { id: string; name: string; input: unknown }[];
  message: Anthropic.Message;
  stopReason: string | null;
  latencyMs: number;
  firstTokenMs: number | null;
  costUsd: number;
  usage: Anthropic.Usage;
}

/** Low-level transport. The real one talks to the Anthropic API; tests inject a scripted one. */
export interface ModelProvider {
  readonly name: string;
  create(params: Anthropic.MessageCreateParamsNonStreaming, signal?: AbortSignal): Promise<Anthropic.Message>;
  stream(
    params: Anthropic.MessageCreateParamsStreaming,
    onText: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<Anthropic.Message>;
}

export class BudgetExceededError extends Error {
  constructor(
    message: string,
    readonly budget: string,
  ) {
    super(message);
  }
}

export class ModelUnavailableError extends Error {}
