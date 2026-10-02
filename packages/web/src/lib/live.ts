import type { HydratedModule } from "@ava/shared";
import { holdTargets, revealTarget } from "./reveal";

export type LiveState = "connecting" | "listening" | "thinking" | "speaking" | "ended" | "error";

export interface LiveHandlers {
  onState(s: LiveState): void;
  onLevel(level: number): void;
  onPartial(text: string): void;
  onUserTurn(text: string): void;
  onAvaText(delta: string, turn: number): void;
  onTurnDone(turn: number): void;
  onModule(m: HydratedModule): void;
  onRemove(key: string): void;
  onLatency(stages: Record<string, number>, total: number | null): void;
  onError(message: string): void;
  onProgress(p: number): void;
}

/**
 * Live mode in the browser: microphone -> 16 kHz PCM over a WebSocket, Ava's
 * audio back as 24 kHz PCM, played gap-free. Barge-in is detected locally so
 * playback stops within a few tens of milliseconds of him speaking.
 */
export class LiveClient {
  private ws: WebSocket | null = null;
  private mic: MediaStream | null = null;
  private inCtx: AudioContext | null = null;
  private outCtx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private playhead = 0;
  private sources: AudioBufferSourceNode[] = [];
  private turn = 0;
  private eotAt = 0;
  private reportedTurn = -1;
  private turnStartCtxTime: number | null = null;
  private loudFrames = 0;
  private state: LiveState = "connecting";
  private outRate = 24000;

  constructor(private h: LiveHandlers) {}

  async start(opts: { conversationId?: string; model?: string }): Promise<void> {
    this.setState("connecting");
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    this.inCtx = new AudioContext();
    await this.inCtx.audioWorklet.addModule("/worklets/mic-processor.js");
    const src = this.inCtx.createMediaStreamSource(this.mic);
    this.node = new AudioWorkletNode(this.inCtx, "mic-processor");
    src.connect(this.node);
    this.outCtx = new AudioContext({ latencyHint: "interactive" });
    const q = new URLSearchParams();
    if (opts.conversationId) q.set("conversation_id", opts.conversationId);
    if (opts.model) q.set("model", opts.model);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/api/live?${q}`);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (ev) => this.onMessage(ev);
    this.ws.onclose = () => {
      if (this.state !== "ended") this.setState("ended");
      this.cleanup();
    };
    this.ws.onerror = () => this.h.onError("The live connection dropped. Check your network and start again.");
    this.node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
      const { pcm, level } = e.data;
      this.h.onLevel(level);
      // Local barge-in: sustained speech while Ava is talking stops her immediately.
      if (this.state === "speaking") {
        this.loudFrames = level > 0.04 ? this.loudFrames + 1 : 0;
        if (this.loudFrames >= 6) {
          this.loudFrames = 0;
          this.stopPlayback();
          this.send({ type: "barge_in" });
        }
      }
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm);
    };
  }

  private send(o: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  private setState(s: LiveState) {
    this.state = s;
    this.h.onState(s);
  }

  setModel(model: string) {
    this.send({ type: "set_model", model });
  }

  endTurnNow() {
    this.send({ type: "end_turn" });
  }

  private onMessage(ev: MessageEvent) {
    if (ev.data instanceof ArrayBuffer) {
      const view = new DataView(ev.data);
      if (view.getUint8(0) !== 1) return;
      const turn = view.getUint32(1, true);
      if (turn !== this.turn) return;
      this.playChunk(new Int16Array(ev.data.slice(5)));
      return;
    }
    const m = JSON.parse(ev.data as string) as { type: string; [k: string]: unknown };
    switch (m.type) {
      case "ready":
        this.outRate = Number(m.out_rate ?? 24000);
        this.setState("listening");
        break;
      case "state":
        if (m.state === "listening" && this.sources.length && this.state === "speaking") break; // let queued audio finish
        this.setState(m.state as LiveState);
        break;
      case "stt":
        if (m.event === "partial") this.h.onPartial(String(m.text ?? ""));
        if (m.event === "eot") {
          this.eotAt = performance.now();
          this.h.onUserTurn(String(m.text ?? ""));
          this.h.onPartial("");
        }
        break;
      case "turn_start":
        this.turn = Number(m.turn);
        this.playhead = 0;
        this.turnStartCtxTime = null;
        break;
      case "text":
        this.h.onAvaText(String(m.delta ?? ""), Number(m.turn));
        break;
      case "cue": {
        const target = String(m.target);
        holdTargets([target]);
        const at = Number(m.at_ms);
        const start = this.turnStartCtxTime;
        if (start !== null && this.outCtx) {
          const delay = Math.max(0, (start + at / 1000 - this.outCtx.currentTime) * 1000);
          window.setTimeout(() => revealTarget(target), delay);
        } else revealTarget(target);
        break;
      }
      case "module":
      case "chips":
        this.h.onModule(m.module as HydratedModule);
        break;
      case "remove":
        this.h.onRemove(String(m.key));
        break;
      case "stop_audio":
        this.stopPlayback();
        break;
      case "turn_done":
        this.h.onTurnDone(Number(m.turn));
        break;
      case "latency":
        this.h.onLatency(m.stages as Record<string, number>, (m.total_ms as number | null) ?? null);
        break;
      case "error":
        this.h.onError(String(m.message));
        break;
    }
  }

  private playChunk(pcm: Int16Array) {
    if (!this.outCtx || !pcm.length) return;
    const buf = this.outCtx.createBuffer(1, pcm.length, this.outRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = this.outCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this.outCtx.destination);
    const startAt = Math.max(this.outCtx.currentTime + 0.02, this.playhead);
    if (this.turnStartCtxTime === null) {
      this.turnStartCtxTime = startAt;
      if (this.reportedTurn !== this.turn) {
        this.reportedTurn = this.turn;
        const ms = Math.round(performance.now() - this.eotAt + (startAt - this.outCtx.currentTime) * 1000);
        this.send({ type: "playback_started", turn: this.turn, ms_since_eot: ms });
      }
    }
    src.start(startAt);
    this.playhead = startAt + buf.duration;
    this.sources.push(src);
    this.setState("speaking");
    src.onended = () => {
      this.sources = this.sources.filter((s) => s !== src);
      if (this.outCtx && this.turnStartCtxTime !== null) this.h.onProgress(Math.min(1, (this.outCtx.currentTime - this.turnStartCtxTime) / Math.max(0.1, this.playhead - this.turnStartCtxTime)));
      if (!this.sources.length && this.state === "speaking") this.setState("listening");
    };
  }

  private stopPlayback() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources = [];
    this.playhead = 0;
    this.turn = -1;
    if (this.state === "speaking" || this.state === "thinking") this.setState("listening");
  }

  stop() {
    this.setState("ended");
    this.ws?.close();
    this.cleanup();
  }

  private cleanup() {
    this.stopPlayback();
    this.mic?.getTracks().forEach((t) => t.stop());
    void this.inCtx?.close().catch(() => {});
    void this.outCtx?.close().catch(() => {});
    this.mic = null;
    this.inCtx = null;
    this.outCtx = null;
  }
}
