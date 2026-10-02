import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { stripTokens, type CanvasState, type HydratedModule, type TurnView } from "@ava/shared";
import { api, streamPost } from "../lib/api";
import { refetchAll, setData, useApi, useServerEvents } from "../lib/store";
import { holdTargets, playSpeech, revealAll, revealTarget, stopSpeech } from "../lib/reveal";
import { clock } from "../lib/time";
import { LiveClient, type LiveState } from "../lib/live";
import { Button, Empty, ErrorLine, Escapement, Sheet, Switch } from "../components/ui";
import { ModuleView } from "../modules/ModuleView";

type TalkEvent =
  | { type: "turn"; turn: TurnView }
  | { type: "status"; state: "extracting" | "thinking" | "speaking" | "idle" }
  | { type: "chips" | "module"; module: HydratedModule }
  | { type: "text"; delta: string }
  | { type: "module_error"; errors: string[] }
  | { type: "remove"; key: string }
  | { type: "replace_text"; text: string }
  | { type: "style_note"; text: string }
  | { type: "done"; turn: TurnView }
  | { type: "audio"; audio_id: string; cues: { target: string; at_ms: number }[] }
  | { type: "error"; message: string };

interface Settings {
  settings: { voice: { autoplay: boolean; live_model: string } };
}

function Transcript({ turns, draft, onPlay, playing }: { turns: TurnView[]; draft: string | null; onPlay: (t: TurnView) => void; playing: string | null }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [turns.length, draft]);
  return (
    <ol className="transcript" aria-live="polite">
      {turns.map((t) => (
        <li key={t.id} className="turn" data-role={t.role}>
          <span className="turn-meta">
            <span className="turn-who">{t.role === "user" ? "You" : "Ava"}</span>
            <span className="num">{clock(t.created_at)}</span>
            {t.role === "user" && t.input_kind ? <span className="turn-kind">{t.input_kind === "live" ? "live" : t.input_kind}</span> : null}
          </span>
          <div className={t.role === "ava" ? "turn-text voice" : "turn-text"}>
            {t.text.split(/\n{2,}/).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
          {t.role === "ava" && t.mode === "async" ? (
            <button type="button" className="turn-play" onClick={() => onPlay(t)} aria-label="Play this reply">
              {playing === t.id ? "Playing" : "Play"}
            </button>
          ) : null}
        </li>
      ))}
      {draft !== null ? (
        <li className="turn" data-role="ava" data-draft="true">
          <span className="turn-meta">
            <span className="turn-who">Ava</span>
          </span>
          <div className="turn-text voice">
            {stripTokens(draft)
              .split(/\n{2,}/)
              .map((p, i) => (
                <p key={i}>{p}</p>
              ))}
          </div>
        </li>
      ) : null}
      <div ref={end} />
    </ol>
  );
}

function Composer({ onSend, onUpload, state, busy, onLive, speak, setSpeak }: { onSend: (t: string) => void; onUpload: (f: File) => void; state: "idle" | "extracting" | "thinking" | "speaking"; busy: boolean; onLive: () => void; speak: boolean; setSpeak: (v: boolean) => void }) {
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem("ava.draft") ?? "";
    } catch {
      return "";
    }
  });
  const ref = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.5))}px`;
  }, [text]);
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem("ava.draft", text);
      } catch {
        /* storage unavailable */
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [text]);
  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t);
    setText("");
  };
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <div className="composer-field">
        <Escapement state={state} />
        <label className="visually-hidden" htmlFor="talk-input">
          Talk to Ava
        </label>
        <textarea
          id="talk-input"
          ref={ref}
          value={text}
          rows={3}
          placeholder="Say what's on your mind. Dictate as long as you like."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          spellCheck
        />
      </div>
      <div className="composer-bar">
        <span className="composer-count num">{words ? `${words} word${words === 1 ? "" : "s"}` : ""}</span>
        <label className="composer-speak">
          <Switch checked={speak} onChange={setSpeak} label="Speak replies" />
          <span>Speak replies</span>
        </label>
        <input
          ref={file}
          type="file"
          accept="audio/*"
          className="visually-hidden"
          tabIndex={-1}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(f);
            e.target.value = "";
          }}
        />
        <Button type="button" kind="quiet" size="sm" onClick={() => file.current?.click()} disabled={busy}>
          Upload audio
        </Button>
        <Button type="button" size="sm" onClick={onLive} disabled={busy}>
          Start live conversation
        </Button>
        <Button type="submit" kind="primary" size="sm" disabled={!text.trim() || busy} title="Send (Ctrl or Cmd + Enter)">
          Send
        </Button>
      </div>
    </form>
  );
}

function LiveBar({ state, level, partial, avaLine, progress, latency, onEnd, onDone, model, models, setModel }: {
  state: LiveState;
  level: number;
  partial: string;
  avaLine: string;
  progress: number;
  latency: number | null;
  onEnd: () => void;
  onDone: () => void;
  model: string;
  models: string[];
  setModel: (m: string) => void;
}) {
  const esc = state === "listening" ? "listening" : state === "speaking" ? "speaking" : state === "thinking" ? "thinking" : "idle";
  const word = state === "connecting" ? "Connecting" : state === "listening" ? "Listening" : state === "thinking" ? "Thinking" : state === "speaking" ? "Speaking" : state === "error" ? "Something went wrong" : "Ended";
  return (
    <div className="livebar" data-state={state}>
      <div className="livebar-state">
        <Escapement state={esc} level={level} progress={progress} size="lg" />
        <span className="livebar-word">{word}</span>
        {latency !== null ? <span className="livebar-latency num" title="End of your turn to Ava's first sound">{latency} ms</span> : null}
      </div>
      <p className="livebar-heard" aria-live="polite">
        {partial || (state === "listening" ? "Take your time. Ava waits until you've finished the thought." : "")}
      </p>
      {avaLine ? <p className="livebar-ava voice">{avaLine}</p> : null}
      <div className="livebar-actions">
        <label className="livebar-model">
          <span className="label">Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => (
              <option key={m} value={m}>
                {m.includes("haiku") ? "Haiku (faster)" : m.includes("sonnet") ? "Sonnet" : m}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" onClick={onDone} disabled={state !== "listening"}>
          I'm done talking
        </Button>
        <Button size="sm" kind="danger" onClick={onEnd}>
          End conversation
        </Button>
      </div>
    </div>
  );
}

export function Talk() {
  const { data, error, reload } = useApi<CanvasState>("/api/canvas");
  const { data: settings } = useApi<Settings>("/api/settings");
  const { data: voice } = useApi<{ live_models: string[] }>("/api/voice/providers");
  const [draft, setDraft] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "extracting" | "thinking" | "speaking">("idle");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [speak, setSpeakState] = useState<boolean | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [live, setLive] = useState<LiveClient | null>(null);
  const [liveState, setLiveState] = useState<LiveState>("ended");
  const [level, setLevel] = useState(0);
  const [partial, setPartial] = useState("");
  const [avaLine, setAvaLine] = useState("");
  const [progress, setProgress] = useState(0);
  const [latency, setLatency] = useState<number | null>(null);
  const [liveModel, setLiveModel] = useState<string>("");
  const held = useRef<Set<string>>(new Set());
  const speakOn = speak ?? settings?.settings.voice.autoplay ?? true;

  useServerEvents((e) => {
    if (e.type === "canvas.changed" && !busy) void reload();
  });

  const conv = data?.conversation_id ?? null;
  const upsert = useCallback((m: HydratedModule) => {
    setData<CanvasState>("/api/canvas", (prev) => {
      if (!prev) return prev as unknown as CanvasState;
      const i = prev.modules.findIndex((x) => x.key === m.key);
      const modules = i >= 0 ? prev.modules.map((x, j) => (j === i ? m : x)) : [...prev.modules, m];
      return { ...prev, modules };
    });
  }, []);
  const removeMod = (key: string) =>
    setData<CanvasState>("/api/canvas", (prev) => (prev ? { ...prev, modules: prev.modules.filter((m) => m.key !== key) } : prev!));
  const addTurn = (t: TurnView) => setData<CanvasState>("/api/canvas", (prev) => (prev ? { ...prev, turns: [...prev.turns.filter((x) => x.id !== t.id), t] } : prev!));

  const playTurn = async (t: TurnView) => {
    try {
      setPlaying(t.id);
      const r = t.audio_id ? { audio_id: t.audio_id, cues: t.cues ?? [] } : await api.post<{ audio_id: string; cues: { target: string; at_ms: number }[] }>(`/api/turns/${t.id}/speak`);
      setState("speaking");
      playSpeech(r.audio_id, r.cues, { onEnd: () => (setPlaying(null), setState("idle")), onProgress: setProgress });
    } catch (e) {
      setPlaying(null);
      setErr((e as Error).message);
    }
  };

  const handle = (e: TalkEvent) => {
    switch (e.type) {
      case "turn":
        addTurn(e.turn);
        break;
      case "status":
        setState(e.state === "idle" ? "idle" : e.state);
        break;
      case "chips":
      case "module":
        if (speakOn && e.type === "module") {
          held.current.add(e.module.key);
          holdTargets([e.module.key]);
        }
        upsert(e.module);
        window.setTimeout(() => document.getElementById(`mod-${e.module.key}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 50);
        break;
      case "remove":
        removeMod(e.key);
        break;
      case "text":
        setDraft((d) => (d ?? "") + e.delta);
        break;
      case "replace_text":
        setDraft(e.text);
        break;
      case "module_error":
        setNotice("One block on the canvas didn't pass validation and was left out. The Log has the details.");
        break;
      case "style_note":
        setNotice(`Style note saved: ${e.text}`);
        break;
      case "done":
        addTurn(e.turn);
        setDraft(null);
        // If no audio is coming, show anything held back.
        if (!speakOn) revealAll();
        else
          window.setTimeout(() => {
            for (const k of held.current) revealTarget(k);
          }, 30_000);
        break;
      case "audio": {
        const cuedModules = new Set(e.cues.map((c) => c.target.split(".")[0]));
        const toShow = [...held.current].filter((k) => !cuedModules.has(k));
        held.current.clear();
        playSpeech(e.audio_id, e.cues, {
          onStart: () => {
            for (const k of toShow) revealTarget(k);
            setState("speaking");
          },
          onEnd: () => setState("idle"),
          onProgress: setProgress,
        });
        break;
      }
      case "error":
        setErr(e.message);
        revealAll();
        break;
    }
  };

  const run = async (fn: () => Promise<void>) => {
    setErr(null);
    setNotice(null);
    setBusy(true);
    stopSpeech();
    held.current.clear();
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
      setDraft(null);
      revealAll();
    } finally {
      setBusy(false);
      setState((s) => (s === "speaking" ? s : "idle"));
      refetchAll();
    }
  };
  const send = (text: string) => run(() => streamPost<TalkEvent>("/api/talk", { text, input_kind: "dictated", conversation_id: conv, speak: speakOn }, handle));
  const upload = (f: File) =>
    run(() => {
      const form = new FormData();
      form.append("audio", f, f.name);
      return streamPost<TalkEvent>("/api/talk/audio", form, handle);
    });

  const startLive = async () => {
    setErr(null);
    stopSpeech();
    const client = new LiveClient({
      onState: setLiveState,
      onLevel: setLevel,
      onPartial: setPartial,
      onUserTurn: (t) => {
        setAvaLine("");
        addTurn({ id: `live-${Date.now()}`, role: "user", mode: "live", text: t, input_kind: "live", created_at: new Date().toISOString(), audio_id: null, cues: null, trimmed_affirmation: false });
      },
      onAvaText: (d) => setAvaLine((l) => stripTokens(l + d)),
      onTurnDone: () => void reload(),
      onModule: upsert,
      onRemove: removeMod,
      onLatency: (_s, total) => setLatency(total),
      onError: (m) => setErr(m),
      onProgress: setProgress,
    });
    setLive(client);
    try {
      await client.start({ conversationId: conv ?? undefined, model: liveModel || undefined });
    } catch (e) {
      setErr(`Couldn't start live mode: ${(e as Error).message}`);
      client.stop();
      setLive(null);
    }
  };
  const endLive = () => {
    live?.stop();
    setLive(null);
    setPartial("");
    setAvaLine("");
    void reload();
  };
  useEffect(() => () => live?.stop(), [live]);
  useEffect(() => {
    if (!liveModel && settings) setLiveModel(settings.settings.voice.live_model);
  }, [settings, liveModel]);

  const setSpeak = (v: boolean) => {
    setSpeakState(v);
    void api.patch("/api/settings", { voice: { autoplay: v } }).catch(() => {});
  };

  if (error) return <ErrorLine error={error} />;
  if (!data) return <div className="screen" aria-busy="true" />;
  const lastAva = [...data.turns].reverse().find((t) => t.role === "ava");
  const dismiss = (key: string) => {
    void api.post(`/api/canvas/${key}/dismiss`, { conversation_id: conv });
    removeMod(key);
  };
  return (
    <div className="screen talk">
      <header className="screen-head talk-head">
        <h1 className="screen-title">Talk</h1>
        <div className="talk-head-actions">
          <Button size="sm" kind="quiet" className="phone-only" onClick={() => setShowTranscript(true)}>
            Transcript
          </Button>
          <Button
            size="sm"
            kind="quiet"
            onClick={() =>
              void api.post<CanvasState>("/api/canvas/new").then((s) => {
                setData<CanvasState>("/api/canvas", () => s);
              })
            }
          >
            New canvas
          </Button>
        </div>
      </header>
      <div className="talk-grid">
        <section className="talk-convo" aria-label="Conversation">
          <div className="talk-scroll">
            {data.turns.length || draft !== null ? <Transcript turns={data.turns} draft={draft} onPlay={(t) => void playTurn(t)} playing={playing} /> : <Empty title="Start by talking.">Tell Ava what's going on, as long as you like. Changes she picks up appear as chips you confirm.</Empty>}
          </div>
        </section>
        <section className="canvas" aria-label="Canvas">
          {data.modules.length ? (
            <div className="canvas-grid">
              {data.modules.map((m) => (
                <ModuleView key={m.key} m={m} conversationId={conv} onDismiss={dismiss} />
              ))}
            </div>
          ) : (
            <Empty title="The canvas is empty.">Lists, plans, options and anything Ava prepares for you appear here as she talks.</Empty>
          )}
        </section>
        <div className="talk-input">
          {lastAva && !live ? (
            <p className="talk-latest voice phone-only">{draft !== null ? stripTokens(draft) : lastAva.text}</p>
          ) : null}
          {notice ? <p className="notice">{notice}</p> : null}
          <ErrorLine error={err} />
          {live ? (
            <LiveBar
              state={liveState}
              level={level}
              partial={partial}
              avaLine={avaLine}
              progress={progress}
              latency={latency}
              onEnd={endLive}
              onDone={() => live.endTurnNow()}
              model={liveModel}
              models={voice?.live_models ?? []}
              setModel={(m) => {
                setLiveModel(m);
                live.setModel(m);
              }}
            />
          ) : (
            <Composer onSend={(t) => void send(t)} onUpload={(f) => void upload(f)} state={state} busy={busy} onLive={() => void startLive()} speak={speakOn} setSpeak={setSpeak} />
          )}
        </div>
      </div>
      <Sheet open={showTranscript} onClose={() => setShowTranscript(false)} title="Transcript">
        <Transcript turns={data.turns} draft={draft} onPlay={(t) => void playTurn(t)} playing={playing} />
      </Sheet>
    </div>
  );
}
