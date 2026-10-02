import type Anthropic from "@anthropic-ai/sdk";
import { alignWordTimings, cueTimes, parseScript, takeSentences, type Cue, type WordTiming } from "@ava/shared";
import type { Services } from "../core/services";
import { newId, js } from "../db/db";
import { DirectiveParser } from "../conversation/directives";
import { affirmingSentences } from "../conversation/affirmation";
import { extract } from "../conversation/extraction";
import { planSpeech } from "./speech-adapt";
import type { StreamSession } from "./tts/types";
import type { SttStream } from "./stt/types";
import { TurnDetector, type TurnSignal } from "./turn-detector";

export const LIVE_IN_RATE = 16000;
export const LIVE_OUT_RATE = 24000;

type Outbound = (msg: Record<string, unknown> | Buffer) => void;

interface Run {
  id: string;
  text: string;
  abort: AbortController;
  tts: StreamSession | null;
  spokenSentences: string[];
  rawAll: string;
  stages: Record<string, number>;
  t0: number;
  speculative: boolean;
  confirmed: boolean;
  bufferedAudio: Buffer[];
  ttsText: string;
  cues: Cue[];
  words: WordTiming[];
  sentCues: Set<string>;
  firstAudioAt: number | null;
  done: boolean;
}

/**
 * One live voice session (a "call"). Audio streams in from the browser,
 * streaming STT with semantic end-of-turn decides when he's done, the model
 * streams tokens into TTS sentence by sentence, and audio streams back.
 * Barge-in stops Ava within a fraction of a second. Every stage is timed.
 */
export class LiveSession {
  private stt: SttStream | null = null;
  private detector: TurnDetector;
  private state: "listening" | "thinking" | "speaking" = "listening";
  private run: Run | null = null;
  private turnSeq = 0;
  private convId: string;
  private bytesIn = 0;
  private arrivals: { audio_s: number; at: number }[] = [];
  private model: string;
  private closed = false;

  constructor(
    private svc: Services,
    private out: Outbound,
    opts: { conversation_id?: string; model?: string },
  ) {
    const v = svc.settings.get().voice;
    this.model = opts.model ?? v.live_model;
    this.convId = opts.conversation_id ?? svc.canvas.current();
    this.detector = new TurnDetector(v.turn_patience, (s) => this.onSignal(s));
  }

  async start(): Promise<void> {
    const { voice, settings, log } = this.svc;
    const stt = voice.sttAdapter();
    if (!stt) throw new Error("Live mode needs DEEPGRAM_API_KEY or ASSEMBLYAI_API_KEY");
    if (!voice.ttsAvailable("live")) throw new Error("Live mode needs a text-to-speech key and a live voice chosen in Settings > Voice");
    if (!this.svc.models.available) throw new Error("Live mode needs ANTHROPIC_API_KEY");
    const v = settings.get().voice;
    this.stt = await stt.connect({ sampleRate: LIVE_IN_RATE, keyterms: v.vocabulary, patience: v.turn_patience }, (e) => {
      if (e.type === "error") this.out({ type: "error", message: e.message });
      else if (e.type === "closed") {
        if (!this.closed) this.out({ type: "error", message: "Speech recognition disconnected" });
      } else this.detector.handle(e);
    });
    log.info("live.start", `Live session started (${stt.label}, ${this.model}, ${this.svc.voice.choice("live").provider} ${this.svc.voice.choice("live").model})`);
    this.setState("listening");
    this.out({ type: "ready", conversation_id: this.convId, in_rate: LIVE_IN_RATE, out_rate: LIVE_OUT_RATE, model: this.model });
  }

  private setState(s: LiveSession["state"]) {
    this.state = s;
    this.out({ type: "state", state: s });
  }

  /** PCM16 mono at 16 kHz from the browser. */
  audio(pcm: Buffer): void {
    this.bytesIn += pcm.length;
    this.arrivals.push({ audio_s: this.bytesIn / 2 / LIVE_IN_RATE, at: Date.now() });
    if (this.arrivals.length > 3000) this.arrivals.splice(0, 1000);
    this.stt?.send(pcm);
  }

  private arrivalOf(audioS: number | null): number | null {
    if (audioS === null) return null;
    const hit = this.arrivals.find((a) => a.audio_s >= audioS);
    return hit?.at ?? null;
  }

  control(msg: { type: string; [k: string]: unknown }): void {
    if (msg.type === "barge_in") this.bargeIn("client");
    else if (msg.type === "playback_started" && this.run && msg.turn === this.turnSeq) {
      this.run.stages.client_playback_ms = Number(msg.ms_since_eot ?? 0);
      this.saveLatency(this.run);
    } else if (msg.type === "set_model" && typeof msg.model === "string") this.model = msg.model;
    else if (msg.type === "end_turn") this.stt?.forceEnd();
  }

  private onSignal(s: TurnSignal): void {
    switch (s.type) {
      case "speech_start":
        if (this.state === "speaking" || this.state === "thinking") this.bargeIn("speech");
        this.out({ type: "stt", event: "start" });
        break;
      case "partial":
        this.out({ type: "stt", event: "partial", text: s.text });
        break;
      case "eager":
        // Start thinking early; nothing is spoken until the turn is confirmed.
        if (!this.run) void this.startRun(s.text, true);
        break;
      case "resumed":
        if (this.run?.speculative && !this.run.confirmed) this.abortRun("speech resumed");
        this.out({ type: "stt", event: "resumed" });
        break;
      case "end":
        void this.onTurnEnd(s.text, s.detected_at, s.audio_end_s, s.held_ms);
        break;
    }
  }

  private async onTurnEnd(text: string, detectedAt: number, audioEnd: number | null, heldMs: number): Promise<void> {
    const speechEndedAt = this.arrivalOf(audioEnd);
    this.out({ type: "stt", event: "eot", text, turn: this.turnSeq + 1 });
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    if (this.run && this.run.speculative && norm(this.run.text) === norm(text)) {
      this.run.confirmed = true;
      this.run.t0 = detectedAt;
      this.run.stages.eot_detect_ms = speechEndedAt ? detectedAt - speechEndedAt : -1;
      this.run.stages.grace_hold_ms = heldMs;
      this.run.stages.speculative = 1;
      this.turnSeq++;
      this.out({ type: "turn_start", turn: this.turnSeq, sample_rate: LIVE_OUT_RATE });
      this.svc.conversation.saveTurn({ convId: this.convId, role: "user", mode: "live", text, input_kind: "live" });
      for (const b of this.run.bufferedAudio.splice(0)) this.sendAudio(b);
      this.flushCues(this.run);
      if (this.run.done) this.finishRun(this.run);
      return;
    }
    if (this.run) this.abortRun("superseded by the final transcript");
    this.svc.conversation.saveTurn({ convId: this.convId, role: "user", mode: "live", text, input_kind: "live" });
    await this.startRun(text, false, { detectedAt, eot_detect_ms: speechEndedAt ? detectedAt - speechEndedAt : -1, grace_hold_ms: heldMs });
  }

  private sendAudio(pcm: Buffer) {
    const head = Buffer.alloc(5);
    head.writeUInt8(1, 0);
    head.writeUInt32LE(this.turnSeq, 1);
    this.out(Buffer.concat([head, pcm]));
  }

  private async startRun(text: string, speculative: boolean, timing?: { detectedAt: number; eot_detect_ms: number; grace_hold_ms: number }): Promise<void> {
    const svc = this.svc;
    const { voice, settings, conversation, models, log } = svc;
    const run: Run = {
      id: newId("lrn"),
      text,
      abort: new AbortController(),
      tts: null,
      spokenSentences: [],
      rawAll: "",
      stages: timing ? { eot_detect_ms: timing.eot_detect_ms, grace_hold_ms: timing.grace_hold_ms } : {},
      t0: timing?.detectedAt ?? Date.now(),
      speculative,
      confirmed: !speculative,
      bufferedAudio: [],
      ttsText: "",
      cues: [],
      words: [],
      sentCues: new Set(),
      firstAudioAt: null,
      done: false,
    };
    this.run = run;
    if (run.confirmed) {
      this.turnSeq++;
      this.out({ type: "turn_start", turn: this.turnSeq, sample_rate: LIVE_OUT_RATE });
    }
    this.setState("thinking");
    const choice = voice.choice("live");
    const v = settings.get().voice;
    const ttsStart = Date.now();
    try {
      run.tts = await voice.tts[choice.provider].stream(
        { model: choice.model, voice_id: choice.voice_id, sampleRate: LIVE_OUT_RATE },
        {
          onAudio: (pcm) => {
            if (this.run !== run) return;
            if (run.firstAudioAt === null) {
              run.firstAudioAt = Date.now();
              run.stages.tts_first_audio_ms = run.firstAudioAt - (run.stages._first_sentence_sent ?? ttsStart);
              run.stages.server_first_audio_ms = run.firstAudioAt - run.t0;
              this.setState("speaking");
            }
            if (run.confirmed) this.sendAudio(pcm);
            else run.bufferedAudio.push(pcm);
          },
          onWords: (words) => {
            if (this.run !== run) return;
            run.words.push(...words.map(({ char_start: _c, ...w }) => w));
            if (run.confirmed) this.flushCues(run);
          },
          onDone: () => {
            if (this.run !== run) return;
            run.done = true;
            if (run.confirmed) this.finishRun(run);
          },
          onError: (e) => {
            log.warn("live.tts_error", `Live TTS error: ${e.message}`);
            this.out({ type: "error", message: `Voice output failed: ${e.message}` });
          },
        },
      );
    } catch (e) {
      this.out({ type: "error", message: (e as Error).message });
      this.setState("listening");
      this.run = null;
      return;
    }
    run.stages.tts_connect_ms = Date.now() - ttsStart;

    let pending = "";
    const affWindow = conversation.recentAffirmations(settings.get().conversation.affirmation_window);
    let affUsed = affWindow;
    const maxAff = settings.get().conversation.affirmation_max;
    const speakSentence = (sentenceRaw: string) => {
      // Affirmation budget, sentence by sentence, before anything is spoken.
      const plain = parseScript(sentenceRaw).text;
      if (affirmingSentences(plain).length) {
        if (affUsed + 1 > maxAff) {
          log.info("affirmation.check", `Dropped a live sentence over the affirmation budget: "${plain}"`);
          return;
        }
        affUsed++;
      }
      const plan = planSpeech(sentenceRaw, { lexicon: v.pronunciations, allowedTones: v.allowed_tones });
      if (!plan.text.trim()) return;
      const base = run.ttsText.length;
      run.ttsText += `${plan.text} `;
      for (const c of plan.cues) run.cues.push({ target: c.target, at: base + c.at });
      if (run.stages.first_sentence_ms === undefined) {
        run.stages.first_sentence_ms = Date.now() - run.t0;
        run.stages._first_sentence_sent = Date.now();
      }
      run.spokenSentences.push(plain);
      run.tts!.send(plan.text, plan.tones[0]?.tone);
    };
    const parser = new DirectiveParser(
      (t) => {
        this.out({ type: "text", delta: t, turn: this.turnSeq });
        pending += t;
        const [sentences, rest] = takeSentences(pending, 8);
        pending = rest;
        for (const s of sentences) speakSentence(s);
      },
      (d) =>
        conversation.handleDirective(
          this.convId,
          d,
          (ev) => {
            if (ev.type === "module") this.out({ type: ev.type, module: ev.module });
            else if (ev.type === "filed") this.out({ type: "filed", filed: ev.filed, needs_you: ev.needs_you });
            else if (ev.type === "remove") this.out({ type: "remove", key: ev.key });
            else if (ev.type === "module_error") this.out({ type: "module_error", errors: ev.errors });
          },
          { id: null },
        ),
    );

    const llmStart = Date.now();
    try {
      const messages: Anthropic.MessageParam[] = [
        ...conversation.history(this.convId, 12).slice(0, speculative ? undefined : -1),
        {
          role: "user",
          content: `${conversation.contextBlock(this.convId, text, true, [
            "Live mode: a real-time spoken conversation, like a call. Keep it conversational and brief unless he's riffing. Start with the point. No fillers ('um', 'let me think', 'great question'). What he tells you is filed into his stack; don't describe it back.",
          ])}\n\n${text}`,
        },
      ];
      await models.stream(
        {
          purpose: "live.reply",
          origin: "interactive",
          model: this.model,
          maxTokens: 900,
          lowLatency: true,
          system: conversation.systemBlocks(true),
          messages,
          signal: run.abort.signal,
          cacheMessages: true,
        },
        (delta) => {
          if (run.stages.llm_ttft_ms === undefined) run.stages.llm_ttft_ms = Date.now() - llmStart;
          run.rawAll += delta;
          parser.push(delta);
        },
      );
      parser.end();
      if (pending.trim()) speakSentence(pending);
      run.stages.llm_total_ms = Date.now() - llmStart;
      run.tts?.finish();
    } catch (e) {
      if (!run.abort.signal.aborted) {
        this.out({ type: "error", message: `Reply failed: ${(e as Error).message}` });
        this.setState("listening");
      }
      run.tts?.cancel();
      if (this.run === run) this.run = null;
    }
  }

  private flushCues(run: Run) {
    if (!run.cues.length) return;
    const aligned = alignWordTimings(run.ttsText, run.words);
    const lastCovered = aligned.length ? aligned[aligned.length - 1].char_start ?? 0 : 0;
    for (const c of cueTimes(run.cues.filter((x) => x.at <= lastCovered && !run.sentCues.has(`${x.target}@${x.at}`)), aligned)) {
      run.sentCues.add(`${c.target}@${run.cues.find((x) => x.target === c.target)?.at}`);
      this.out({ type: "cue", target: c.target, at_ms: c.at_ms, turn: this.turnSeq });
    }
  }

  private finishRun(run: Run) {
    if (this.run !== run) return;
    const spoken = run.spokenSentences.join(" ");
    const t = this.svc.conversation.saveTurn({ convId: this.convId, role: "ava", mode: "live", text: spoken, raw: run.rawAll, affirmation: affirmingSentences(spoken).length > 0 });
    this.out({ type: "turn_done", turn: this.turnSeq, ava_turn: t });
    this.flushCues(run);
    this.saveLatency(run);
    this.run = null;
    this.setState("listening");
    // Anything that changes state goes through chips on screen, extracted in the background.
    void this.backgroundExtract(run.text);
  }

  private async backgroundExtract(text: string) {
    if (text.split(/\s+/).length < 4) return;
    try {
      const changes = await extract(this.svc, text, { purpose: "live.extract", origin: "interactive" });
      if (!changes.length) return;
      const f = this.svc.filing.file(changes, { origin: "conversation", evidence_id: null });
      this.out({ type: "filed", filed: f.filed.length, needs_you: f.needs_you.length });
    } catch (e) {
      this.svc.log.warn("extraction.failed", `Live extraction failed: ${(e as Error).message}`);
    }
  }

  private saveLatency(run: Run) {
    const { db, clock, voice } = this.svc;
    const choice = voice.choice("live");
    const stages = Object.fromEntries(Object.entries(run.stages).filter(([k]) => !k.startsWith("_")));
    const total = run.stages.client_playback_ms ?? run.stages.server_first_audio_ms ?? null;
    db.run(
      "INSERT INTO latency_samples (id, at, mode, model, tts, stt, stages, total_ms) VALUES (?, ?, 'live', ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET stages = excluded.stages, total_ms = excluded.total_ms",
      [run.id, clock.now().toISOString(), this.model, `${choice.provider}:${choice.model}`, voice.sttAdapter()?.id ?? "none", js(stages), total],
    );
    this.out({ type: "latency", turn: this.turnSeq, stages, total_ms: total });
  }

  private abortRun(reason: string) {
    const r = this.run;
    if (!r) return;
    r.abort.abort();
    r.tts?.cancel();
    this.run = null;
    this.svc.log.info("live.abort", `Stopped a reply in progress: ${reason}`);
  }

  /** He started talking while Ava was speaking: stop at once and listen. */
  private bargeIn(by: "client" | "speech") {
    const r = this.run;
    if (!r) return;
    const said = r.spokenSentences.join(" ");
    this.abortRun(`barge-in (${by})`);
    this.out({ type: "stop_audio", turn: this.turnSeq });
    if (said && r.confirmed) this.svc.conversation.saveTurn({ convId: this.convId, role: "ava", mode: "live", text: `${said} [interrupted]`, raw: r.rawAll });
    this.setState("listening");
  }

  close(): void {
    this.closed = true;
    this.abortRun("session closed");
    this.detector.reset();
    this.stt?.close();
    this.svc.log.info("live.end", "Live session ended");
  }
}
