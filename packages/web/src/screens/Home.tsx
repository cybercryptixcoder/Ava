import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { stripTokens, type ArtifactView as Artifact, type CanvasState, type CardResponse, type CardResult, type CardView, type ExternalActionView, type StackView, type TurnView } from "@ava/shared";
import { api, streamPost } from "../lib/api";
import { refetchAll, setData, useApi } from "../lib/store";
import { playSpeech, stopSpeech } from "../lib/reveal";
import { clock, clock12, dayLabel, local, now } from "../lib/time";
import { LiveClient, type LiveState } from "../lib/live";
import { Button, ErrorLine, Escapement, Sheet, Switch } from "../components/ui";
import { MenuButton } from "../components/MenuButton";
import { Stack } from "../components/Stack";
import { InputBar } from "../components/InputBar";
import { LiveBar } from "../components/LiveBar";
import { LayerSheet } from "../components/CardLayer";
import { Transcript } from "../components/Transcript";
import { Toast } from "../components/Toast";
import { ArtifactView, ConfirmSend } from "../components/ArtifactView";

type TalkState = "idle" | "extracting" | "thinking" | "speaking";

interface SettingsResp {
  settings: { voice: { autoplay: boolean } };
}

type TalkEvent =
  | { type: "turn"; turn: TurnView }
  | { type: "status"; state: TalkState }
  | { type: "filed"; filed: number; needs_you: number }
  | { type: "text"; delta: string }
  | { type: "replace_text"; text: string }
  | { type: "style_note"; text: string }
  | { type: "done"; turn: TurnView }
  | { type: "audio"; audio_id: string; cues: { target: string; at_ms: number }[]; duration_ms: number | null }
  | { type: "error"; message: string };

function nextLabel(iso: string): string {
  const l = dayLabel(iso);
  const day = l === "Today" ? "" : l === "Tomorrow" || l === "Yesterday" ? `${l.toLowerCase()} ` : `${l} `;
  return `${day}at ${clock12(iso)}`;
}

/**
 * The front room: Ava's judgment, not her database. One card at a time, a
 * quiet top, and the input bar; everything else lives a layer deeper or in
 * the menu.
 */
export function Home() {
  const { data: stack } = useApi<StackView>("/api/stack");
  const { data: canvas, reload: reloadCanvas } = useApi<CanvasState>("/api/canvas");
  const { data: settings } = useApi<SettingsResp>("/api/settings");

  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [focusToken, setFocusToken] = useState(0);
  const [talk, setTalk] = useState<TalkState>("idle");
  const [draft, setDraft] = useState<string | null>(null);
  const [avaLine, setAvaLine] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const saidTimer = useRef<number | null>(null);
  const [speakState, setSpeakState] = useState<boolean | null>(null);
  const speakOn = speakState ?? settings?.settings.voice.autoplay ?? true;

  const [layerCard, setLayerCard] = useState<CardView | null>(null);
  const [holdCard, setHoldCard] = useState<CardView | null>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [action, setAction] = useState<ExternalActionView | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [morningPlaying, setMorningPlaying] = useState(false);

  const [live, setLive] = useState<LiveClient | null>(null);
  const [liveState, setLiveState] = useState<LiveState>("ended");
  const [level, setLevel] = useState(0);
  const [partial, setPartial] = useState("");
  const [liveLine, setLiveLine] = useState("");
  const [latency, setLatency] = useState<number | null>(null);

  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((x) => x + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
      if (saidTimer.current !== null) window.clearTimeout(saidTimer.current);
    },
    [],
  );

  // The push deep link: /?card=<id> brings that card to the front of the deck.
  const loc = useLocation();
  const focusId = useMemo(() => new URLSearchParams(loc.search).get("card"), [loc.search]);
  useEffect(() => {
    if (focusId) window.history.replaceState(null, "", loc.pathname);
  }, [focusId, loc.pathname]);
  const cards = useMemo(() => {
    const list = stack?.cards ?? [];
    if (!focusId) return list;
    const i = list.findIndex((c) => c.id === focusId);
    return i > 0 ? [list[i], ...list.slice(0, i), ...list.slice(i + 1)] : list;
  }, [stack, focusId]);

  const showToast = useCallback((m: string) => {
    setToast(m);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4200);
  }, []);
  const say = useCallback((text: string) => {
    setAvaLine(text);
    if (saidTimer.current !== null) window.clearTimeout(saidTimer.current);
    saidTimer.current = window.setTimeout(() => setAvaLine(null), 15_000);
  }, []);

  const openArtifactById = useCallback(
    async (id: string) => {
      try {
        setArtifact(await api.get<Artifact>(`/api/artifacts/${id}`));
      } catch (e) {
        showToast((e as Error).message);
      }
    },
    [showToast],
  );
  const openActionById = useCallback(
    async (id: string) => {
      try {
        const list = await api.get<ExternalActionView[]>("/api/actions");
        const a = list.find((x) => x.id === id);
        if (a) setAction(a);
        else showToast("That draft is gone");
      } catch (e) {
        showToast((e as Error).message);
      }
    },
    [showToast],
  );

  const respond = useCallback(
    async (card: CardView, response: CardResponse, option?: string | null, viaKeyboard?: boolean) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const r = await api.post<{ result: CardResult; stack: StackView }>(`/api/cards/${card.id}/respond`, { response, option: option ?? null });
        setData<StackView>("/api/stack", () => r.stack);
        if (r.result.summary) showToast(r.result.summary);
        if (r.result.open?.kind === "action") await openActionById(r.result.open.id);
        else if (r.result.open?.kind === "artifact") await openArtifactById(r.result.open.id);
        refetchAll();
      } catch (e) {
        showToast((e as Error).message);
        refetchAll();
      } finally {
        busyRef.current = false;
        setBusy(false);
        if (viaKeyboard) setFocusToken((x) => x + 1);
      }
    },
    [openActionById, openArtifactById, showToast],
  );

  const handleTalk = useCallback(
    (e: TalkEvent) => {
      switch (e.type) {
        case "status":
          setTalk(e.state);
          break;
        case "text":
          setDraft((d) => (d ?? "") + e.delta);
          break;
        case "replace_text":
          setDraft(e.text);
          break;
        case "filed":
          showToast(`Filed ${e.filed} thing${e.filed === 1 ? "" : "s"}${e.needs_you ? `, ${e.needs_you} need${e.needs_you === 1 ? "s" : ""} you` : ""}`);
          break;
        case "style_note":
          showToast(`Style note saved: ${e.text}`);
          break;
        case "done":
          setDraft(null);
          say(stripTokens(e.turn.text));
          break;
        case "audio":
          stopSpeech();
          playSpeech(e.audio_id, e.cues, {
            onStart: () => setTalk("speaking"),
            onEnd: () => {
              setTalk("idle");
              setProgress(0);
            },
            onProgress: setProgress,
          });
          break;
        case "error":
          setErr(e.message);
          setDraft(null);
          break;
        default:
          break;
      }
    },
    [say, showToast],
  );

  const runTalk = async (fn: () => Promise<void>) => {
    setErr(null);
    setDraft(null);
    stopSpeech();
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
      setDraft(null);
    } finally {
      void reloadCanvas();
      refetchAll();
      setTalk((s) => (s === "speaking" ? s : "idle"));
    }
  };
  const sendText = (text: string) => {
    setAvaLine(null);
    void runTalk(() => streamPost<TalkEvent>("/api/talk", { text, input_kind: "typed", conversation_id: canvas?.conversation_id, speak: speakOn }, handleTalk));
  };
  const sendAudio = (file: File) => {
    setAvaLine(null);
    void runTalk(() => {
      const form = new FormData();
      form.append("audio", file, file.name);
      return streamPost<TalkEvent>("/api/talk/audio", form, handleTalk);
    });
  };

  const playTurn = async (t: TurnView) => {
    try {
      setPlaying(t.id);
      const r = t.audio_id ? { audio_id: t.audio_id, cues: t.cues ?? [] } : await api.post<{ audio_id: string; cues: { target: string; at_ms: number }[] }>(`/api/turns/${t.id}/speak`);
      setTalk("speaking");
      playSpeech(r.audio_id, r.cues, {
        onEnd: () => {
          setPlaying(null);
          setTalk("idle");
        },
        onProgress: setProgress,
      });
    } catch (e) {
      setPlaying(null);
      setErr((e as Error).message);
    }
  };
  const playMorning = async () => {
    if (!stack?.morning) return;
    try {
      setMorningPlaying(true);
      const r = await api.post<{ audio_id: string; cues: { target: string; at_ms: number }[] }>(`/api/brief/${stack.morning.brief_id}/speak`);
      setTalk("speaking");
      playSpeech(r.audio_id, r.cues, {
        onEnd: () => {
          setMorningPlaying(false);
          setTalk("idle");
        },
        onProgress: setProgress,
      });
    } catch (e) {
      setMorningPlaying(false);
      showToast((e as Error).message);
    }
  };

  const startLive = async () => {
    setErr(null);
    stopSpeech();
    const client = new LiveClient({
      onState: setLiveState,
      onLevel: setLevel,
      onPartial: setPartial,
      onUserTurn: () => {
        setLiveLine("");
        void reloadCanvas();
      },
      onAvaText: (d) => setLiveLine((l) => stripTokens(l + d)),
      onTurnDone: () => void reloadCanvas(),
      onModule: () => {},
      onRemove: () => {},
      onLatency: (_s, total) => setLatency(total),
      onError: (m) => setErr(m),
      onProgress: setProgress,
    });
    setLive(client);
    try {
      await client.start({ conversationId: canvas?.conversation_id ?? undefined });
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
    setLiveLine("");
    void reloadCanvas();
  };
  useEffect(() => () => live?.stop(), [live]);

  const setSpeak = (v: boolean) => {
    setSpeakState(v);
    void api.patch("/api/settings", { voice: { autoplay: v } }).catch(() => {});
  };

  const said = draft !== null ? stripTokens(draft) : avaLine;
  return (
    <div className="home">
      <header className="home-top">
        <div className="home-clock">
          <span className="home-time num">{clock(now())}</span>
          <span className="home-date">{local(now()).toFormat("cccc d LLLL")}</span>
        </div>
        <MenuButton />
      </header>

      <section className="home-middle" aria-label="What needs you">
        {stack?.morning ? (
          <div className="home-morning">
            <button type="button" className="linklike" onClick={() => void playMorning()} disabled={morningPlaying}>
              {morningPlaying ? "Playing the morning line" : "Play the morning line"}
            </button>
          </div>
        ) : null}
        {!stack ? (
          <div className="home-boot" aria-busy="true" />
        ) : cards.length ? (
          <Stack cards={cards} busy={busy} focusToken={focusToken} focusedId={focusId} onRespond={(c, r, o, kb) => void respond(c, r, o, kb)} onOpen={setLayerCard} onHold={setHoldCard} />
        ) : (
          <div className="clear">
            <span className="clear-mark" aria-hidden="true" />
            <p className="clear-title">Nothing needs you.</p>
            {stack.all_clear?.next_check_in ? <p className="clear-next">Ava checks in again {nextLabel(stack.all_clear.next_check_in.due_at)}.</p> : null}
          </div>
        )}
        {stack && stack.waiting > 0 ? <p className="stack-more">{stack.waiting} more waiting</p> : null}
      </section>

      <footer className="home-bottom">
        <div className="home-said" aria-live="polite">
          {!live ? <Escapement state={talk} progress={progress} /> : null}
          <span className="home-said-text">{said ?? ""}</span>
        </div>
        <ErrorLine error={err} />
        {live ? (
          <LiveBar state={liveState} level={level} partial={partial} avaLine={liveLine} progress={progress} latency={latency} onEnd={endLive} onDone={() => live.endTurnNow()} />
        ) : (
          <InputBar busy={busy || talk === "extracting" || talk === "thinking"} onSend={sendText} onAudio={sendAudio} onLive={() => void startLive()} />
        )}
        <div className="home-quiet">
          <button type="button" className="linklike" onClick={() => setShowTranscript(true)}>
            Transcript
          </button>
        </div>
      </footer>

      <Toast message={toast} />

      {layerCard ? <LayerSheet card={layerCard} onClose={() => setLayerCard(null)} onRespond={respond} onOpenAction={(id) => void openActionById(id)} /> : null}

      <Sheet open={holdCard !== null} onClose={() => setHoldCard(null)} title={holdCard?.title ?? ""}>
        <div className="hold-actions">
          {holdCard?.has_items ? (
            <Button
              onClick={() => {
                const c = holdCard;
                setHoldCard(null);
                void respond(c, "already_done");
              }}
            >
              Already done
            </Button>
          ) : null}
          <Button
            kind="quiet"
            onClick={() => {
              const c = holdCard;
              setHoldCard(null);
              if (c) void respond(c, "stop");
            }}
          >
            Stop suggesting this
          </Button>
        </div>
      </Sheet>

      <Sheet open={showTranscript} onClose={() => setShowTranscript(false)} title="Transcript" wide>
        <label className="transcript-tools">
          <Switch checked={speakOn} onChange={setSpeak} label="Speak replies" />
          <span>Speak replies</span>
        </label>
        {canvas ? <Transcript turns={canvas.turns} draft={draft} onPlay={(t) => void playTurn(t)} playing={playing} /> : <div aria-busy="true" />}
      </Sheet>

      <Sheet open={artifact !== null} onClose={() => setArtifact(null)} title={artifact?.title ?? "Prepared for you"} wide>
        {artifact ? <ArtifactView artifact={artifact} moduleKey={`art-${artifact.id}`} /> : null}
      </Sheet>

      {action ? <ConfirmSend action={action} onClose={() => setAction(null)} /> : null}
    </div>
  );
}
