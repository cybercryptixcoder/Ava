import Anthropic from "@anthropic-ai/sdk";
import type { ModelProvider } from "./types";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Models that accept server-side refusal fallbacks with fallbacks: "default". */
function supportsFallback(model: string): boolean {
  return /^claude-(opus-5|sonnet-5-5|fable)/.test(model);
}

/**
 * The real transport. Uses the official SDK. Opus and Sonnet requests opt
 * into server-side refusal fallbacks (configurable), which requires the beta
 * namespace; everything else uses the stable namespace.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(
    apiKey: string,
    private fallback: boolean,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2 });
  }

  private useFallback(params: { model: string; thinking?: unknown }): boolean {
    const thinking = params.thinking as { type?: string } | undefined;
    // A between_tools request is only valid on Sonnet 5.5; keep live-mode turns on the plain path.
    return this.fallback && supportsFallback(String(params.model)) && thinking?.type !== "between_tools";
  }

  async create(params: Anthropic.MessageCreateParamsNonStreaming, signal?: AbortSignal): Promise<Anthropic.Message> {
    if (this.useFallback(params)) {
      const msg = await this.client.beta.messages.create(
        { ...(params as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming), betas: [FALLBACK_BETA], fallbacks: "default" },
        { signal },
      );
      return msg as unknown as Anthropic.Message;
    }
    return this.client.messages.create(params, { signal });
  }

  async stream(
    params: Anthropic.MessageCreateParamsStreaming,
    onText: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<Anthropic.Message> {
    const { stream: _s, ...rest } = params;
    if (this.useFallback(params)) {
      const s = this.client.beta.messages.stream(
        { ...(rest as unknown as Parameters<Anthropic["beta"]["messages"]["stream"]>[0]), betas: [FALLBACK_BETA], fallbacks: "default" },
        { signal },
      );
      s.on("text", (t) => onText(t));
      return (await s.finalMessage()) as unknown as Anthropic.Message;
    }
    const s = this.client.messages.stream(rest as Anthropic.MessageStreamParams, { signal });
    s.on("text", (t) => onText(t));
    return s.finalMessage();
  }
}
