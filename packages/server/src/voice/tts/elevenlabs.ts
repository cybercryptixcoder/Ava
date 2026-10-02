import WebSocket from "ws";
import { charsToWords, type Tone, type WordTiming } from "@ava/shared";
import type { StreamHandlers, StreamSession, SynthesisResult, TtsAdapter, TtsModelInfo, TtsVoice } from "./types";

const API = "https://api.elevenlabs.io";

/** Eleven v3 takes inline audio tags for delivery; other models would read them aloud. */
const V3_TAGS: Record<Tone, string> = {
  gentler: "[gently]",
  lighter: "[lightly]",
  serious: "[seriously]",
  warmer: "[warmly]",
  brisk: "[briskly]",
};

/** Turbo/Flash models can't take tags; nudge delivery through voice settings instead. */
function settingsFor(tone?: Tone) {
  const base = { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true };
  if (tone === "serious") return { ...base, stability: 0.6, style: 0.05 };
  if (tone === "lighter" || tone === "warmer") return { ...base, stability: 0.38, style: 0.3 };
  if (tone === "gentler") return { ...base, stability: 0.55, style: 0.2, speed: 0.95 };
  return base;
}

/**
 * ElevenLabs: Eleven v3 for expressive async speech, Flash v2.5 for live
 * mode, with the same voice id across both so Ava sounds like one person.
 * Word timings come from the provider's character alignment.
 */
export class ElevenLabsTts implements TtsAdapter {
  readonly id = "elevenlabs" as const;
  readonly label = "ElevenLabs";

  constructor(private key: string | null) {}

  available(): boolean {
    return !!this.key;
  }

  models(): TtsModelInfo[] {
    return [
      { id: "eleven_v3", label: "Eleven v3", role: "expressive", tone: "tags", notes: "Most expressive; audio tags for delivery. Higher latency; async replies and briefs." },
      { id: "eleven_multilingual_v2", label: "Multilingual v2", role: "expressive", tone: "controls", notes: "Stable, natural narration quality." },
      { id: "eleven_flash_v2_5", label: "Flash v2.5", role: "low_latency", tone: "controls", notes: "Lowest latency (~75 ms model time); live mode." },
      { id: "eleven_turbo_v2_5", label: "Turbo v2.5", role: "both", tone: "controls", notes: "Balance of quality and latency." },
    ];
  }

  private headers() {
    return { "xi-api-key": this.key!, "content-type": "application/json" };
  }

  async voices(): Promise<TtsVoice[]> {
    const res = await fetch(`${API}/v1/voices`, { headers: this.headers() });
    if (!res.ok) throw new Error(`ElevenLabs voices: HTTP ${res.status}`);
    const body = (await res.json()) as { voices: { voice_id: string; name: string; description?: string; labels?: Record<string, string>; preview_url?: string }[] };
    return body.voices.map((v) => ({
      id: v.voice_id,
      name: v.name,
      description: v.description ?? Object.values(v.labels ?? {}).join(", "),
      preview_url: v.preview_url ?? null,
    }));
  }

  async synthesize(text: string, opts: { model: string; voice_id: string; tone?: Tone }): Promise<SynthesisResult> {
    if (!opts.voice_id) throw new Error("Pick an ElevenLabs voice in Settings > Voice");
    const isV3 = opts.model.startsWith("eleven_v3");
    const input = isV3 && opts.tone ? `${V3_TAGS[opts.tone]} ${text}` : text;
    const res = await fetch(`${API}/v1/text-to-speech/${encodeURIComponent(opts.voice_id)}/with-timestamps?output_format=mp3_44100_128`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ text: input, model_id: opts.model, ...(isV3 ? {} : { voice_settings: settingsFor(opts.tone) }) }),
    });
    if (!res.ok) throw new Error(`ElevenLabs TTS: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      audio_base64: string;
      alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } | null;
    };
    const audio = Buffer.from(body.audio_base64, "base64");
    let words: WordTiming[] = [];
    let timing: SynthesisResult["timing"] = "provider";
    if (body.alignment?.characters?.length) {
      words = charsToWords(
        body.alignment.characters,
        body.alignment.character_start_times_seconds.map((s) => s * 1000),
        body.alignment.character_end_times_seconds.map((s) => s * 1000),
      ).map(({ char_start: _c, ...w }) => w);
    } else {
      words = await this.forcedAlignment(audio, text);
      timing = "forced_alignment";
    }
    const duration = words.length ? words[words.length - 1].end_ms : null;
    return { audio, mime: "audio/mpeg", words, duration_ms: duration, timing };
  }

  /** If a model returns no alignment, align the text to the audio with ElevenLabs' forced-alignment API. */
  private async forcedAlignment(audio: Buffer, text: string): Promise<WordTiming[]> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }), "speech.mp3");
    form.append("text", text);
    const res = await fetch(`${API}/v1/forced-alignment`, { method: "POST", headers: { "xi-api-key": this.key! }, body: form });
    if (!res.ok) throw new Error(`ElevenLabs forced alignment: HTTP ${res.status}`);
    const body = (await res.json()) as { words: { text: string; start: number; end: number }[] };
    return body.words.filter((w) => w.text.trim()).map((w) => ({ word: w.text, start_ms: w.start * 1000, end_ms: w.end * 1000 }));
  }

  async stream(opts: { model: string; voice_id: string; sampleRate: number }, h: StreamHandlers): Promise<StreamSession> {
    if (!opts.voice_id) throw new Error("Pick an ElevenLabs voice for live mode");
    const fmt = `pcm_${opts.sampleRate}`;
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(opts.voice_id)}/stream-input?model_id=${encodeURIComponent(opts.model)}&output_format=${fmt}&sync_alignment=true&inactivity_timeout=30`;
    const ws = new WebSocket(url, { headers: { "xi-api-key": this.key! } });
    let audioMs = 0;
    let charBase = 0;
    let closed = false;
    const pending: string[] = [];
    let open = false;
    ws.on("open", () => {
      open = true;
      ws.send(JSON.stringify({ text: " ", voice_settings: settingsFor(), generation_config: { chunk_length_schedule: [50, 90, 160, 250] } }));
      for (const p of pending.splice(0)) ws.send(p);
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          audio?: string | null;
          isFinal?: boolean | null;
          alignment?: { chars?: string[]; charStartTimesMs?: number[]; charDurationsMs?: number[] } | null;
          error?: string;
          message?: string;
        };
        if (msg.error) {
          h.onError(new Error(`ElevenLabs: ${msg.message ?? msg.error}`));
          return;
        }
        if (msg.audio) {
          const pcm = Buffer.from(msg.audio, "base64");
          const chunkStart = audioMs;
          audioMs += (pcm.length / 2 / opts.sampleRate) * 1000;
          const a = msg.alignment;
          if (a?.chars?.length && a.charStartTimesMs && a.charDurationsMs) {
            const starts = a.charStartTimesMs.map((s) => s + chunkStart);
            const ends = a.charStartTimesMs.map((s, i) => s + chunkStart + (a.charDurationsMs![i] ?? 0));
            const words = charsToWords(a.chars, starts, ends, charBase);
            charBase += a.chars.length;
            if (words.length) h.onWords(words);
          }
          h.onAudio(pcm);
        }
        if (msg.isFinal) {
          closed = true;
          h.onDone();
          ws.close();
        }
      } catch (e) {
        h.onError(e as Error);
      }
    });
    ws.on("error", (e) => !closed && h.onError(e));
    ws.on("close", () => {
      if (!closed) {
        closed = true;
        h.onDone();
      }
    });
    const sendJson = (o: unknown) => {
      const s = JSON.stringify(o);
      if (open) ws.send(s);
      else pending.push(s);
    };
    return {
      send: (text) => sendJson({ text: `${text.trim()} `, flush: true }),
      finish: () => sendJson({ text: "" }),
      cancel: () => {
        closed = true;
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      },
    };
  }
}
