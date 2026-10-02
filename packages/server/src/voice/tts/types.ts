import type { Tone, WordTiming } from "@ava/shared";

export interface TtsModelInfo {
  id: string;
  label: string;
  /** Expressive model for async replies and briefs, or low-latency model for live mode. */
  role: "expressive" | "low_latency" | "both";
  tone: "tags" | "controls" | "none";
  notes: string;
}

export interface TtsVoice {
  id: string;
  name: string;
  description: string;
  preview_url: string | null;
}

export interface SynthesisResult {
  audio: Buffer;
  mime: string;
  words: WordTiming[];
  duration_ms: number | null;
  /** How word timings were obtained. */
  timing: "provider" | "forced_alignment";
}

export interface StreamSession {
  /** Queue a sentence (already speech-adapted). */
  send(text: string, tone?: Tone): void;
  /** No more text for this turn. */
  finish(): void;
  /** Stop immediately (barge-in). */
  cancel(): void;
}

export interface StreamHandlers {
  onAudio(pcm: Buffer): void;
  /** Word timings relative to the start of this stream's audio, with char offsets into the concatenated text sent. */
  onWords(words: WordTiming[]): void;
  onDone(): void;
  onError(e: Error): void;
}

export interface TtsAdapter {
  readonly id: "elevenlabs" | "cartesia";
  readonly label: string;
  available(): boolean;
  models(): TtsModelInfo[];
  voices(): Promise<TtsVoice[]>;
  /** Whole-utterance synthesis with word timings (async replies, briefs, audition). */
  synthesize(text: string, opts: { model: string; voice_id: string; tone?: Tone }): Promise<SynthesisResult>;
  /** Low-latency streaming synthesis (live mode). PCM 16-bit mono at `sampleRate`. */
  stream(opts: { model: string; voice_id: string; sampleRate: number }, h: StreamHandlers): Promise<StreamSession>;
}
