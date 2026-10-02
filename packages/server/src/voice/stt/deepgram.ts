import WebSocket from "ws";
import { patienceParams, type SttAdapter, type SttEvent, type SttStream } from "./types";

/**
 * Deepgram Flux: conversational speech recognition with native semantic
 * end-of-turn detection (EagerEndOfTurn, TurnResumed, EndOfTurn) and
 * keyterm prompting for course codes, project names and people.
 * Audio files use Nova-3 pre-recorded transcription.
 */
export class DeepgramStt implements SttAdapter {
  readonly id = "deepgram" as const;
  readonly label = "Deepgram Flux";

  constructor(private key: string | null) {}

  available(): boolean {
    return !!this.key;
  }

  async connect(opts: { sampleRate: number; keyterms: string[]; patience: number }, on: (e: SttEvent) => void): Promise<SttStream> {
    const p = patienceParams(opts.patience);
    const q = new URLSearchParams({
      model: "flux-general-en",
      encoding: "linear16",
      sample_rate: String(opts.sampleRate),
      eot_threshold: String(p.eot_threshold),
      eager_eot_threshold: String(p.eager_eot_threshold),
      eot_timeout_ms: String(p.eot_timeout_ms),
    });
    for (const k of opts.keyterms.slice(0, 100)) q.append("keyterm", k);
    const ws = new WebSocket(`wss://api.deepgram.com/v2/listen?${q}`, { headers: { authorization: `Token ${this.key}` } });
    let inTurn = false;
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        const m = JSON.parse(data.toString()) as {
          type: string;
          event?: string;
          transcript?: string;
          end_of_turn_confidence?: number;
          audio_window_end?: number;
          trigger?: string;
          description?: string;
        };
        if (m.type === "Connected") on({ type: "ready" });
        else if (m.type === "TurnInfo") {
          const text = (m.transcript ?? "").trim();
          switch (m.event) {
            case "StartOfTurn":
              inTurn = true;
              on({ type: "speech_start" });
              break;
            case "Update":
              if (text) on({ type: "partial", text });
              break;
            case "EagerEndOfTurn":
              on({ type: "eager_eot", text });
              break;
            case "TurnResumed":
              on({ type: "resumed", text });
              break;
            case "EndOfTurn":
              inTurn = false;
              on({ type: "eot", text, confidence: m.end_of_turn_confidence ?? null, audio_end_s: m.audio_window_end ?? null, trigger: m.trigger ?? null });
              break;
          }
        } else if (m.type === "Error" || m.type === "FatalError") on({ type: "error", message: m.description ?? "Deepgram error" });
      } catch (e) {
        on({ type: "error", message: (e as Error).message });
      }
    });
    ws.on("error", (e) => on({ type: "error", message: `Deepgram: ${e.message}` }));
    ws.on("close", () => on({ type: "closed" }));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return {
      send: (pcm) => ws.readyState === WebSocket.OPEN && ws.send(pcm),
      forceEnd: () => inTurn && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "ForceEndTurn" })),
      close: () => {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
          ws.close();
        } catch {
          /* closed */
        }
      },
    };
  }

  async transcribeFile(audio: Buffer, mime: string, keyterms: string[]): Promise<string> {
    const q = new URLSearchParams({ model: "nova-3", smart_format: "true", punctuate: "true", language: "en" });
    for (const k of keyterms.slice(0, 100)) q.append("keyterm", k);
    const res = await fetch(`https://api.deepgram.com/v1/listen?${q}`, {
      method: "POST",
      headers: { authorization: `Token ${this.key}`, "content-type": mime || "audio/webm" },
      body: new Uint8Array(audio),
    });
    if (!res.ok) throw new Error(`Deepgram transcription: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } };
    return body.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
  }
}
