export type SttEvent =
  | { type: "ready" }
  | { type: "speech_start" }
  | { type: "partial"; text: string }
  /** Moderate confidence the turn is over: a chance to start thinking early. */
  | { type: "eager_eot"; text: string }
  /** Speech continued after an eager end-of-turn. */
  | { type: "resumed"; text: string }
  /** The provider's semantic end-of-turn. `audio_end_s` is the position in the stream where speech ended. */
  | { type: "eot"; text: string; confidence: number | null; audio_end_s: number | null; trigger: string | null }
  | { type: "error"; message: string }
  | { type: "closed" };

export interface SttStream {
  send(pcm16: Buffer): void;
  /** Force the provider to end the current turn now. */
  forceEnd(): void;
  close(): void;
}

export interface SttAdapter {
  readonly id: "deepgram" | "assemblyai";
  readonly label: string;
  available(): boolean;
  /** Streaming recognition with semantic end-of-turn, tuned by patience (0 quick … 1 very patient). */
  connect(opts: { sampleRate: number; keyterms: string[]; patience: number }, on: (e: SttEvent) => void): Promise<SttStream>;
  /** Transcribe an uploaded audio file. */
  transcribeFile?(audio: Buffer, mime: string, keyterms: string[]): Promise<string>;
}

/** Map the single patience setting onto provider thresholds. */
export function patienceParams(p: number) {
  const x = Math.max(0, Math.min(1, p));
  return {
    // Deepgram Flux
    eot_threshold: Math.round((0.6 + 0.3 * x) * 100) / 100,
    eager_eot_threshold: Math.round((0.4 + 0.25 * x) * 100) / 100,
    eot_timeout_ms: Math.round(3000 + 7000 * x),
    // AssemblyAI Universal-Streaming
    end_of_turn_confidence_threshold: Math.round((0.5 + 0.4 * x) * 100) / 100,
    min_turn_silence: Math.round(400 + 1600 * x),
    max_turn_silence: Math.round(2500 + 5000 * x),
    // Our own grace period for unfinished-sounding endings
    trailing_grace_ms: Math.round(400 + 1600 * x),
  };
}
