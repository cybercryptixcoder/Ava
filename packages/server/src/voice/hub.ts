import fs from "node:fs";
import path from "node:path";
import { alignWordTimings, cueTimes, type WordTiming } from "@ava/shared";
import type { Services } from "../core/services";
import { planSpeech } from "./speech-adapt";
import { CartesiaTts } from "./tts/cartesia";
import { ElevenLabsTts } from "./tts/elevenlabs";
import type { TtsAdapter, TtsModelInfo, TtsVoice } from "./tts/types";
import { AssemblyAiStt } from "./stt/assemblyai";
import { DeepgramStt } from "./stt/deepgram";
import type { SttAdapter } from "./stt/types";

export interface RenderedSpeech {
  audio_id: string;
  cues: { target: string; at_ms: number }[];
  duration_ms: number | null;
  words: WordTiming[];
  spoken_text: string;
}

export interface AuditionLine {
  key: string;
  label: string;
  text: string;
}

/**
 * Voice providers behind adapters, so they can be swapped. Text-to-speech:
 * ElevenLabs and Cartesia. Speech-to-text: Deepgram Flux and AssemblyAI.
 */
export class VoiceHub {
  readonly tts: Record<"elevenlabs" | "cartesia", TtsAdapter>;
  readonly stt: Record<"deepgram" | "assemblyai", SttAdapter>;

  constructor(private svc: Services) {
    this.tts = { elevenlabs: new ElevenLabsTts(svc.cfg.elevenlabs.key), cartesia: new CartesiaTts(svc.cfg.cartesia.key) };
    this.stt = { deepgram: new DeepgramStt(svc.cfg.deepgramKey), assemblyai: new AssemblyAiStt(svc.cfg.assemblyaiKey) };
  }

  choice(mode: "async" | "live") {
    const v = this.svc.settings.get().voice;
    return mode === "async" ? v.async_voice : v.live_voice;
  }

  ttsAvailable(mode: "async" | "live"): boolean {
    const c = this.choice(mode);
    return this.tts[c.provider].available() && !!c.voice_id;
  }

  sttAdapter(): SttAdapter | null {
    const pref = this.svc.settings.get().voice.stt_provider;
    if (this.stt[pref].available()) return this.stt[pref];
    return Object.values(this.stt).find((s) => s.available()) ?? null;
  }

  providers(): { id: string; label: string; available: boolean; models: TtsModelInfo[] }[] {
    return Object.values(this.tts).map((t) => ({ id: t.id, label: t.label, available: t.available(), models: t.models() }));
  }

  async voices(provider: "elevenlabs" | "cartesia"): Promise<TtsVoice[]> {
    const a = this.tts[provider];
    if (!a.available()) throw new Error(`${a.label} isn't configured`);
    return a.voices();
  }

  /** Speak a whole reply (async mode, briefs). Cue tokens become reveal times. */
  async renderAsync(raw: string, opts: { purpose: string; operational: boolean; mode?: "async" | "live" }): Promise<RenderedSpeech | null> {
    const { settings, audio, log } = this.svc;
    const c = this.choice(opts.mode ?? "async");
    const adapter = this.tts[c.provider];
    if (!adapter.available() || !c.voice_id) return null;
    const v = settings.get().voice;
    const plan = planSpeech(raw, { lexicon: v.pronunciations, allowedTones: v.allowed_tones });
    if (!plan.text.trim()) return null;
    if (plan.droppedListLines) log.info("tts.lists", `Kept ${plan.droppedListLines} list line(s) on screen instead of reading them aloud`);
    const started = Date.now();
    const res = await adapter.synthesize(plan.text, { model: c.model, voice_id: c.voice_id, tone: plan.tones[0]?.tone });
    const words = alignWordTimings(plan.text, res.words);
    const cues = cueTimes(plan.cues, words);
    const id = audio.save(res.audio, res.mime, "tts", { words, cues });
    log.info("tts.rendered", `${opts.purpose}: ${adapter.label} ${c.model}, ${Math.round((res.duration_ms ?? 0) / 100) / 10} s of audio in ${Date.now() - started} ms (${res.timing} timings)`);
    return { audio_id: id, cues, duration_ms: res.duration_ms, words, spoken_text: plan.text };
  }

  auditionLines(): AuditionLine[] {
    const p = path.join(this.svc.cfg.personalityDir, "audition.json");
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")) as AuditionLine[];
    return [];
  }

  /** Render one audition line with a given provider/model/voice (cached on disk by combination). */
  async audition(provider: "elevenlabs" | "cartesia", model: string, voiceId: string, lineKey: string): Promise<{ audio_id: string; ms: number }> {
    const { db, audio } = this.svc;
    const line = this.auditionLines().find((l) => l.key === lineKey);
    if (!line) throw new Error(`No audition line ${lineKey}`);
    const cacheKey = `audition:${provider}:${model}:${voiceId}:${lineKey}:${line.text.length}`;
    const hit = db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [cacheKey]);
    if (hit && audio.load(hit.value)) return { audio_id: hit.value, ms: 0 };
    const v = this.svc.settings.get().voice;
    const plan = planSpeech(line.text, { lexicon: v.pronunciations, allowedTones: v.allowed_tones });
    const started = Date.now();
    const res = await this.tts[provider].synthesize(plan.text, { model, voice_id: voiceId, tone: plan.tones[0]?.tone });
    const ms = Date.now() - started;
    const id = audio.save(res.audio, res.mime, "audition", { words: alignWordTimings(plan.text, res.words) });
    db.run("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [cacheKey, id, this.svc.clock.now().toISOString()]);
    return { audio_id: id, ms };
  }

  async transcribeFile(buf: Buffer, mime: string): Promise<string> {
    const a = this.stt.deepgram;
    if (!a.available() || !a.transcribeFile) throw new Error("Audio transcription needs DEEPGRAM_API_KEY");
    return a.transcribeFile(buf, mime, this.svc.settings.get().voice.vocabulary);
  }
}
