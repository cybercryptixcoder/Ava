import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Db } from "../db/db";
import { js, newId } from "../db/db";
import type { Clock } from "../core/clock";
import type { DecisionLog } from "../core/log";
import type { Counters, SettingsStore } from "../core/settings-store";
import type { Cipher } from "../security/crypto";
import { BudgetExceededError, ModelUnavailableError, type ModelProvider, type ModelRequest, type ModelResult } from "./types";

/** USD per million tokens. */
const PRICING: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-4-5": { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-opus-5": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

export function estimateCost(model: string, u: Partial<Anthropic.Usage>): number {
  const p = PRICING[model] ?? { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 };
  const cost =
    ((u.input_tokens ?? 0) * p.in +
      (u.output_tokens ?? 0) * p.out +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

const isHaiku = (m: string) => m.startsWith("claude-haiku");

/**
 * Every model call goes through here. The gateway enforces the daily
 * budgets (separate from the message cap), applies prompt caching, logs
 * every call's inputs and outputs (encrypted), and records cost.
 */
export class ModelGateway {
  constructor(
    private provider: ModelProvider | null,
    private db: Db,
    private clock: Clock,
    private cipher: Cipher,
    private counters: Counters,
    private settings: SettingsStore,
    private log: DecisionLog,
  ) {}

  get available(): boolean {
    return !!this.provider;
  }

  setProvider(p: ModelProvider | null): void {
    this.provider = p;
  }

  /** Throws BudgetExceededError if the call would go over today's budget. */
  checkBudget(origin: "system" | "interactive"): void {
    const b = this.settings.get().budgets;
    const calls = this.counters.get(`model.calls.${origin}`);
    const limit = origin === "system" ? b.system_calls : b.interactive_calls;
    if (calls >= limit) throw new BudgetExceededError(`Daily ${origin} model-call budget reached (${calls}/${limit})`, `calls.${origin}`);
    const spent = this.counters.get("model.cost_usd");
    if (spent >= b.usd) throw new BudgetExceededError(`Daily spend ceiling reached ($${spent.toFixed(2)} of $${b.usd.toFixed(2)})`, "usd");
  }

  private buildParams(req: ModelRequest): Record<string, unknown> {
    const systemBlocks = (typeof req.system === "string" ? [{ text: req.system, cache: true }] : req.system).map((b) => ({
      type: "text" as const,
      text: b.text,
      ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));
    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: systemBlocks,
      messages: req.messages,
    };
    if (req.cacheMessages) params.cache_control = { type: "ephemeral" };
    if (req.tools?.length) params.tools = req.tools;
    const outputConfig: Record<string, unknown> = {};
    if (!isHaiku(req.model)) {
      // Opus 5.5 defaults to medium effort; Sonnet 5.5 to high. Be explicit.
      outputConfig.effort = req.effort ?? (req.lowLatency ? "low" : "medium");
      if (req.lowLatency && req.model.startsWith("claude-sonnet-5-5")) params.thinking = { type: "between_tools" };
    }
    if (req.schema) outputConfig.format = zodOutputFormat(req.schema as never);
    if (Object.keys(outputConfig).length) params.output_config = outputConfig;
    return params;
  }

  private record(req: ModelRequest, status: string, extra: { output?: unknown; usage?: Anthropic.Usage; latency?: number; cost?: number; error?: string }) {
    const id = newId("mdl");
    this.db.run(
      "INSERT INTO model_calls (id, at, purpose, origin, model, wake_id, status, input_enc, output_enc, usage, latency_ms, cost_usd, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        this.clock.now().toISOString(),
        req.purpose,
        req.origin,
        req.model,
        req.wakeId ?? null,
        status,
        this.cipher.encJson({ system: req.system, messages: req.messages, tools: req.tools?.map((t) => t.name) }),
        extra.output === undefined ? null : this.cipher.encJson(extra.output),
        extra.usage ? js(extra.usage) : null,
        extra.latency ?? null,
        extra.cost ?? null,
        extra.error ?? null,
      ],
    );
    return id;
  }

  private finish<T>(req: ModelRequest<T>, message: Anthropic.Message, started: number, firstTokenMs: number | null): ModelResult<T> {
    const latencyMs = Date.now() - started;
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const toolUses = message.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));
    let parsed: T | null = null;
    let parseError: string | null = null;
    if (req.schema) {
      if (message.stop_reason === "refusal") parseError = "The model declined this request";
      else if (message.stop_reason === "max_tokens") parseError = "Output was cut off at max_tokens";
      else {
        try {
          const r = req.schema.safeParse(JSON.parse(text));
          if (r.success) parsed = r.data;
          else parseError = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        } catch (e) {
          parseError = `Output was not valid JSON: ${(e as Error).message}`;
        }
      }
    }
    const cost = estimateCost(message.model ?? req.model, message.usage);
    this.counters.add("model.cost_usd", cost);
    const callId = this.record(req, parseError ? "parse_error" : message.stop_reason === "refusal" ? "refused" : "ok", {
      output: { content: message.content, stop_reason: message.stop_reason },
      usage: message.usage,
      latency: latencyMs,
      cost,
      error: parseError ?? undefined,
    });
    this.log.info(
      "model.call",
      `${req.purpose}: ${req.model}, ${latencyMs} ms, ${message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0)} in / ${message.usage.output_tokens} out${message.usage.cache_read_input_tokens ? ` (${message.usage.cache_read_input_tokens} cached)` : ""}, $${cost.toFixed(4)}${parseError ? `; ${parseError}` : ""}`,
      { call_id: callId, purpose: req.purpose, stop_reason: message.stop_reason },
      req.wakeId,
    );
    return {
      callId,
      text,
      parsed,
      parseError,
      toolUses,
      message,
      stopReason: message.stop_reason,
      latencyMs,
      firstTokenMs,
      costUsd: cost,
      usage: message.usage,
    };
  }

  private preflight(req: ModelRequest): ModelProvider {
    if (!this.provider) {
      this.log.warn("model.unavailable", `${req.purpose}: no ANTHROPIC_API_KEY, model call skipped`, undefined, req.wakeId);
      throw new ModelUnavailableError("No ANTHROPIC_API_KEY configured");
    }
    try {
      this.checkBudget(req.origin);
    } catch (e) {
      this.record(req, "budget_blocked", { error: (e as Error).message });
      this.log.warn("budget.blocked", `${req.purpose}: ${(e as Error).message}`, undefined, req.wakeId);
      throw e;
    }
    this.counters.add(`model.calls.${req.origin}`);
    return this.provider;
  }

  async complete<T>(req: ModelRequest<T>): Promise<ModelResult<T>> {
    const provider = this.preflight(req);
    const started = Date.now();
    try {
      const msg = await provider.create(this.buildParams(req) as unknown as Anthropic.MessageCreateParamsNonStreaming, req.signal, { purpose: req.purpose, origin: req.origin });
      return this.finish(req, msg, started, null);
    } catch (e) {
      if (e instanceof BudgetExceededError) throw e;
      this.record(req, "error", { error: (e as Error).message, latency: Date.now() - started });
      this.log.error("model.error", `${req.purpose}: ${(e as Error).message}`, undefined, req.wakeId);
      throw e;
    }
  }

  async stream<T>(req: ModelRequest<T>, onText: (delta: string) => void): Promise<ModelResult<T>> {
    const provider = this.preflight(req);
    const started = Date.now();
    let first: number | null = null;
    try {
      const msg = await provider.stream(
        { ...(this.buildParams(req) as unknown as Anthropic.MessageCreateParamsStreaming), stream: true },
        (d) => {
          if (first === null) first = Date.now() - started;
          onText(d);
        },
        req.signal,
        { purpose: req.purpose, origin: req.origin },
      );
      return this.finish(req, msg, started, first);
    } catch (e) {
      const aborted = req.signal?.aborted;
      this.record(req, aborted ? "aborted" : "error", { error: (e as Error).message, latency: Date.now() - started });
      if (!aborted) this.log.error("model.error", `${req.purpose}: ${(e as Error).message}`, undefined, req.wakeId);
      throw e;
    }
  }
}
