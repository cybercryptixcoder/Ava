import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { buildApp, type App } from "../src/app";
import type { AppConfig } from "../src/config/config";
import { SimClock } from "../src/core/clock";
import type { CallMeta, ModelProvider } from "../src/models/types";
import type { Services } from "../src/core/services";
import type { ItemDraft } from "@ava/shared";

/** Monday 5 October 2026, 10:00 in State College (14:00 UTC). */
export const MONDAY_10AM = "2026-10-05T14:00:00Z";

export type Reply = string | Record<string, unknown> | { tool_use: { name: string; input: unknown } };
export type Handler = (params: Record<string, unknown>, call: number) => Reply;

/**
 * A model provider that answers from a script keyed by call purpose. Test
 * flows run through the real gateway (budgets, logging, schema parsing), so
 * everything but the network is exercised.
 */
export class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  readonly calls: { purpose: string; params: Record<string, unknown> }[] = [];
  constructor(private handlers: Record<string, Handler | Reply>) {}

  private message(params: Record<string, unknown>, meta?: CallMeta): Anthropic.Message {
    const purpose = meta?.purpose ?? "unknown";
    this.calls.push({ purpose, params });
    const h = this.handlers[purpose] ?? Object.entries(this.handlers).find(([k]) => k.endsWith("*") && purpose.startsWith(k.slice(0, -1)))?.[1];
    if (h === undefined) throw new Error(`No scripted reply for ${purpose}`);
    const n = this.calls.filter((c) => c.purpose === purpose).length - 1;
    const r = typeof h === "function" ? h(params, n) : h;
    const content: Anthropic.ContentBlock[] =
      typeof r === "object" && r !== null && "tool_use" in r
        ? [{ type: "tool_use", id: `toolu_${n}`, name: (r as { tool_use: { name: string } }).tool_use.name, input: (r as { tool_use: { input: unknown } }).tool_use.input, caller: { type: "direct" } } as unknown as Anthropic.ContentBlock]
        : [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r), citations: null } as Anthropic.ContentBlock];
    return {
      id: `msg_${this.calls.length}`,
      type: "message",
      role: "assistant",
      model: String(params.model),
      content,
      stop_reason: content[0].type === "tool_use" ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    } as unknown as Anthropic.Message;
  }

  async create(params: Anthropic.MessageCreateParamsNonStreaming, _signal?: AbortSignal, meta?: CallMeta): Promise<Anthropic.Message> {
    return this.message(params as unknown as Record<string, unknown>, meta);
  }

  async stream(params: Anthropic.MessageCreateParamsStreaming, onText: (d: string) => void, _signal?: AbortSignal, meta?: CallMeta): Promise<Anthropic.Message> {
    const m = this.message(params as unknown as Record<string, unknown>, meta);
    for (const b of m.content) if (b.type === "text") for (const chunk of b.text.match(/[\s\S]{1,17}/g) ?? []) onText(chunk);
    return m;
  }

  count(purpose: string): number {
    return this.calls.filter((c) => c.purpose === purpose).length;
  }
}

export interface TestApp {
  app: App;
  svc: Services;
  clock: SimClock;
  close(): void;
}

/**
 * A full app on an in-memory database and a simulated clock. External
 * services are switched off whatever the developer's .env holds, so tests
 * never reach the network.
 */
export function makeApp(opts: { at?: string; provider?: ModelProvider | null; config?: Partial<AppConfig> } = {}): TestApp {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ava-test-"));
  const clock = new SimClock(opts.at ?? MONDAY_10AM);
  const offline: Partial<AppConfig> = {
    profile: "test",
    production: false,
    dataDir,
    passwordHash: null,
    anthropicKey: null,
    elevenlabs: { key: null, voiceId: null },
    cartesia: { key: null, voiceId: null },
    deepgramKey: null,
    assemblyaiKey: null,
    vapid: { publicKey: null, privateKey: null, subject: "mailto:test@localhost" },
    google: { clientId: null, clientSecret: null, gmailSend: false },
    deadmanPingUrl: null,
    collectorToken: null,
  };
  const app = buildApp({ config: { ...offline, ...opts.config }, provider: opts.provider ?? null, clock, dbFile: ":memory:" });
  return {
    app,
    svc: app.svc,
    clock,
    close() {
      app.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function addItem(svc: Services, draft: ItemDraft) {
  return svc.items.create(draft, { source: "manual", via: "test" });
}

export const hours = (h: number) => h * 3_600_000;
