import WebSocket from "ws";
import { patienceParams, type SttAdapter, type SttEvent, type SttStream } from "./types";

/**
 * AssemblyAI Universal-Streaming (v3): semantic end-of-turn detection with
 * tunable confidence and silence windows, plus keyterms prompting.
 */
export class AssemblyAiStt implements SttAdapter {
  readonly id = "assemblyai" as const;
  readonly label = "AssemblyAI Universal-Streaming";

  constructor(private key: string | null) {}

  available(): boolean {
    return !!this.key;
  }

  async connect(opts: { sampleRate: number; keyterms: string[]; patience: number }, on: (e: SttEvent) => void): Promise<SttStream> {
    const p = patienceParams(opts.patience);
    const q = new URLSearchParams({
      sample_rate: String(opts.sampleRate),
      encoding: "pcm_s16le",
      format_turns: "true",
      end_of_turn_confidence_threshold: String(p.end_of_turn_confidence_threshold),
      min_turn_silence: String(p.min_turn_silence),
      max_turn_silence: String(p.max_turn_silence),
    });
    if (opts.keyterms.length) q.set("keyterms_prompt", JSON.stringify(opts.keyterms.slice(0, 100)));
    const ws = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?${q}`, { headers: { authorization: this.key! } });
    let turnOrder = -1;
    let ended = new Set<number>();
    ws.on("message", (data) => {
      try {
        const m = JSON.parse(data.toString()) as { type: string; turn_order?: number; transcript?: string; end_of_turn?: boolean; turn_is_formatted?: boolean; end_of_turn_confidence?: number; words?: { end: number }[]; error?: string };
        if (m.type === "Begin") on({ type: "ready" });
        else if (m.type === "Turn") {
          const order = m.turn_order ?? 0;
          const text = (m.transcript ?? "").trim();
          if (order !== turnOrder && text) {
            turnOrder = order;
            on({ type: "speech_start" });
          }
          if (!m.end_of_turn) {
            if (text) on({ type: "partial", text });
          } else if (m.turn_is_formatted && !ended.has(order)) {
            ended.add(order);
            if (ended.size > 50) ended = new Set([order]);
            const lastWord = m.words?.[m.words.length - 1];
            on({ type: "eot", text, confidence: m.end_of_turn_confidence ?? null, audio_end_s: lastWord ? lastWord.end / 1000 : null, trigger: "model" });
          }
        } else if (m.type === "Error") on({ type: "error", message: m.error ?? "AssemblyAI error" });
      } catch (e) {
        on({ type: "error", message: (e as Error).message });
      }
    });
    ws.on("error", (e) => on({ type: "error", message: `AssemblyAI: ${e.message}` }));
    ws.on("close", () => on({ type: "closed" }));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return {
      send: (pcm) => ws.readyState === WebSocket.OPEN && ws.send(pcm),
      forceEnd: () => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "ForceEndpoint" })),
      close: () => {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "Terminate" }));
          ws.close();
        } catch {
          /* closed */
        }
      },
    };
  }
}
