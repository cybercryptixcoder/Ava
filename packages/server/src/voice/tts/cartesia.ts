import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type { Tone, WordTiming } from "@ava/shared";
import type { StreamHandlers, StreamSession, SynthesisResult, TtsAdapter, TtsModelInfo, TtsVoice } from "./types";
import { pcmToWav } from "../audio-util";

const API = "https://api.cartesia.ai";
const VERSION = "2026-08-14";

/** Sonic-3 takes an emotion per request; we map Ava's sparing tone marks onto it. */
const EMOTION: Record<Tone, string> = {
  gentler: "calm",
  lighter: "content",
  serious: "neutral",
  warmer: "affectionate",
  brisk: "neutral",
};

/**
 * Cartesia Sonic: one model family for both modes (Sonic-3.5 is expressive
 * and fast), native word timestamps, and an emotion control.
 */
export class CartesiaTts implements TtsAdapter {
  readonly id = "cartesia" as const;
  readonly label = "Cartesia";

  constructor(private key: string | null) {}

  available(): boolean {
    return !!this.key;
  }

  models(): TtsModelInfo[] {
    return [
      { id: "sonic-3.5", label: "Sonic 3.5", role: "both", tone: "controls", notes: "Most natural Sonic; low latency; word timestamps." },
      { id: "sonic-3", label: "Sonic 3", role: "both", tone: "controls", notes: "Fast, emotion controls, word timestamps." },
    ];
  }

  private headers() {
    return { authorization: `Bearer ${this.key}`, "cartesia-version": VERSION, "content-type": "application/json" };
  }

  async voices(): Promise<TtsVoice[]> {
    const res = await fetch(`${API}/voices?limit=100`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Cartesia voices: HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { id: string; name: string; description: string }[] } | { id: string; name: string; description: string }[];
    const list = Array.isArray(body) ? body : (body.data ?? []);
    return list.map((v) => ({ id: v.id, name: v.name, description: v.description, preview_url: null }));
  }

  async synthesize(text: string, opts: { model: string; voice_id: string; tone?: Tone }): Promise<SynthesisResult> {
    if (!opts.voice_id) throw new Error("Pick a Cartesia voice in Settings > Voice");
    const res = await fetch(`${API}/tts/sse`, {
      method: "POST",
      headers: { ...this.headers(), accept: "text/event-stream" },
      body: JSON.stringify({
        model_id: opts.model,
        transcript: text,
        voice: opts.voice_id,
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 },
        add_timestamps: true,
        ...(opts.tone ? { generation_config: { emotion: EMOTION[opts.tone] } } : {}),
      }),
    });
    if (!res.ok || !res.body) throw new Error(`Cartesia TTS: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const pcm: Buffer[] = [];
    const words: WordTiming[] = [];
    const decoder = new TextDecoder();
    let buf = "";
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!data) continue;
        const ev = JSON.parse(data) as { type: string; data?: string; word_timestamps?: { words: string[]; start: number[]; end: number[] }; message?: string };
        if (ev.type === "chunk" && ev.data) pcm.push(Buffer.from(ev.data, "base64"));
        else if (ev.type === "timestamps" && ev.word_timestamps) {
          const w = ev.word_timestamps;
          w.words.forEach((word, i) => words.push({ word, start_ms: w.start[i] * 1000, end_ms: w.end[i] * 1000 }));
        } else if (ev.type === "error") throw new Error(`Cartesia: ${ev.message}`);
      }
    }
    const raw = Buffer.concat(pcm);
    return { audio: pcmToWav(raw, 24000), mime: "audio/wav", words, duration_ms: (raw.length / 2 / 24000) * 1000, timing: "provider" };
  }

  async stream(opts: { model: string; voice_id: string; sampleRate: number }, h: StreamHandlers): Promise<StreamSession> {
    if (!opts.voice_id) throw new Error("Pick a Cartesia voice for live mode");
    const ws = new WebSocket(`wss://api.cartesia.ai/tts/websocket?cartesia_version=${VERSION}`, { headers: { authorization: `Bearer ${this.key}`, "cartesia-version": VERSION } });
    const contextId = randomUUID();
    let open = false;
    let closed = false;
    let charBase = 0;
    const pending: string[] = [];
    const sentTexts: string[] = [];
    ws.on("open", () => {
      open = true;
      for (const p of pending.splice(0)) ws.send(p);
    });
    ws.on("message", (data) => {
      try {
        const ev = JSON.parse(data.toString()) as { type: string; data?: string; word_timestamps?: { words: string[]; start: number[]; end: number[] }; done?: boolean; message?: string };
        if (ev.type === "chunk" && ev.data) h.onAudio(Buffer.from(ev.data, "base64"));
        else if (ev.type === "timestamps" && ev.word_timestamps) {
          const w = ev.word_timestamps;
          h.onWords(w.words.map((word, i) => ({ word, start_ms: w.start[i] * 1000, end_ms: w.end[i] * 1000 })));
        } else if (ev.type === "done") {
          closed = true;
          h.onDone();
          ws.close();
        } else if (ev.type === "error") h.onError(new Error(`Cartesia: ${ev.message}`));
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
    const send = (o: unknown) => {
      const s = JSON.stringify(o);
      if (open) ws.send(s);
      else pending.push(s);
    };
    const base = {
      model_id: opts.model,
      voice: opts.voice_id,
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: opts.sampleRate },
      context_id: contextId,
      add_timestamps: true,
    };
    return {
      send: (text, tone) => {
        const t = `${text.trim()} `;
        sentTexts.push(t);
        charBase += t.length;
        send({ ...base, transcript: t, continue: true, ...(tone ? { generation_config: { emotion: EMOTION[tone] } } : {}) });
      },
      finish: () => send({ ...base, transcript: "", continue: false }),
      cancel: () => {
        closed = true;
        try {
          send({ context_id: contextId, cancel: true });
          ws.close();
        } catch {
          /* closed */
        }
      },
    };
  }
}
