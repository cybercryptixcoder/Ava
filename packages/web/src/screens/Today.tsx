import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { DateTime } from "luxon";
import { stripTokens, type BriefView, type TodayView, type ExternalActionView } from "@ava/shared";
import { api } from "../lib/api";
import { refetchAll, useApi } from "../lib/store";
import { clock12, now, tz } from "../lib/time";
import { playSpeech, stopSpeech } from "../lib/reveal";
import { Button, Empty, ErrorLine, Escapement } from "../components/ui";
import { MessageCard } from "../components/MessageCard";
import { DayTimeline } from "../modules/DayTimeline";
import { ChipRow, RuleSummary } from "../modules/modules";
import { ConfirmSend } from "../modules/ArtifactView";
import { LocationSwitch } from "../App";

/** "After lunch…" reads as one sentence after the time; names keep their capitals. */
function lowerLead(reason: string): string {
  return /^(After|Before|Checking|Free|Preparing|Planning)\b/.test(reason) ? reason.charAt(0).toLowerCase() + reason.slice(1) : reason;
}

function useNarrow(): boolean {
  const q = "(max-width: 1023px)";
  const [narrow, setNarrow] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

function DialHeader({ view }: { view: TodayView }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((x) => x + 1), 15_000);
    return () => window.clearInterval(t);
  }, []);
  const l = DateTime.fromJSDate(now()).setZone(tz());
  const next = view.next_wake;
  return (
    <header className="today-head">
      <div className="today-time">
        <span className="dial-time num" aria-label={`It's ${l.toFormat("HH:mm")}`}>
          {l.toFormat("HH:mm")}
        </span>
        <span className="today-date">{l.toFormat("cccc d LLLL")}</span>
      </div>
      <div className="today-phone-loc">
        <LocationSwitch compact />
      </div>
      <p className="today-next">
        {next ? (
          <>
            Next check-in <span className="num steel">{clock12(next.due_at)}</span>, {lowerLead(next.reason)}
          </>
        ) : (
          "No check-ins planned."
        )}
      </p>
      {view.plan_note ? <p className="today-plan voice-sm">{view.plan_note}</p> : null}
    </header>
  );
}

function BriefPanel({ brief, autoplay }: { brief: BriefView; autoplay: boolean }) {
  const [state, setState] = useState<"idle" | "loading" | "speaking">("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const played = useRef(false);
  const play = async () => {
    setError(null);
    setState("loading");
    try {
      const r = await api.post<{ audio_id: string; cues: { target: string; at_ms: number }[] }>(`/api/brief/${brief.id}/speak`);
      playSpeech(r.audio_id, r.cues, { onStart: () => setState("speaking"), onEnd: () => setState("idle"), onProgress: setProgress });
    } catch (e) {
      setError((e as Error).message);
      setState("idle");
    }
  };
  useEffect(() => {
    if (autoplay && !played.current) {
      played.current = true;
      void play();
    }
    return () => stopSpeech();
  }, [autoplay]);
  return (
    <section className="brief" aria-label="Morning brief">
      <header className="brief-head">
        <h2 className="section-title">Morning brief</h2>
        {state !== "idle" ? <Escapement state={state === "speaking" ? "speaking" : "thinking"} progress={progress} /> : null}
      </header>
      <p className="voice brief-text">{stripTokens(brief.spoken)}</p>
      <div className="row-actions">
        {state === "speaking" ? (
          <Button size="sm" onClick={() => (stopSpeech(), setState("idle"))}>
            Stop
          </Button>
        ) : (
          <Button size="sm" busy={state === "loading"} onClick={() => void play()}>
            Play the brief
          </Button>
        )}
      </div>
      <ErrorLine error={error} />
      {brief.messages.length ? (
        <div className="brief-queued">
          <p className="label">Queued overnight</p>
          {brief.messages.map((m) => (
            <MessageCard key={m.id} m={m} compact />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function QuestionCard({ q }: { q: NonNullable<TodayView["waiting"]["question"]> }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/api/questions/${q.id}/answer`, { answer });
      refetchAll();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="question" aria-label="A question from Ava">
      <p className="voice question-text">{q.text}</p>
      <p className="question-why">{q.why}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (answer.trim()) void submit();
        }}
      >
        <label className="visually-hidden" htmlFor="q-answer">
          Your answer
        </label>
        <textarea id="q-answer" rows={2} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Answer in your own words" />
        <div className="row-actions">
          <Button kind="primary" size="sm" type="submit" busy={busy} disabled={!answer.trim()}>
            Answer
          </Button>
          <Button size="sm" kind="quiet" type="button" onClick={() => void api.post(`/api/questions/${q.id}/dismiss`).then(refetchAll)}>
            Skip this question
          </Button>
        </div>
      </form>
    </section>
  );
}

export function Today() {
  const { data, error } = useApi<TodayView>("/api/today");
  const [params] = useSearchParams();
  const [sendAction, setSendAction] = useState<ExternalActionView | null>(null);
  const [expanded, setExpanded] = useState(false);
  const narrow = useNarrow();
  const { data: settings } = useApi<{ settings: { voice: { autoplay: boolean } } }>("/api/settings");
  if (error) return <ErrorLine error={error} />;
  if (!data) return <div className="screen" aria-busy="true" />;
  const w = data.waiting;
  const nothingWaiting = !data.brief && !w.messages.length && !w.proposals.length && !w.rule_proposals.length && !w.external_actions.length && !w.question;
  const autoplay = params.get("brief") === "1" && !!settings?.settings.voice.autoplay;
  const rest = [
    ...w.messages
      .filter((m) => !data.brief?.messages.some((b) => b.id === m.id))
      .map((m) => <MessageCard key={m.id} m={m} />),
    ...w.external_actions.map((a) => (
      <section key={a.id} className="pending-send">
        <p>
          An email to <strong>{a.preview.to}</strong> is waiting for your confirmation.
        </p>
        <Button size="sm" kind="primary" onClick={() => setSendAction(a)}>
          Review and send
        </Button>
      </section>
    )),
    ...(w.proposals.length
      ? [
          <section key="chips" className="waiting-chips">
            <h3 className="label">Changes to confirm</h3>
            <ul className="chips-list">
              {w.proposals.slice(0, 12).map((p) => (
                <ChipRow key={p.id} p={p} />
              ))}
            </ul>
          </section>,
        ]
      : []),
    ...w.rule_proposals.map((r) => (
      <section key={r.id} className="waiting-rule">
        <h3 className="label">Rule proposal: {r.name}</h3>
        <RuleSummary rule={r} />
      </section>
    )),
  ];
  return (
    <div className="screen today">
      <DialHeader view={data} />
      <div className="today-grid">
        <section className="today-dial" aria-label="Today's timeline">
          <div className="dial-legend" aria-hidden="true">
            <span className="legend-his">Your calendar</span>
            <span className="legend-ava">Ava's plan</span>
          </div>
          {data.timeline.data.type === "day_timeline" ? <DayTimeline data={data.timeline.data} moduleKey="today" /> : null}
        </section>
        <aside className="today-waiting" aria-label="Waiting for you">
          <h2 className="section-title">Waiting for you</h2>
          {nothingWaiting ? <Empty title="Nothing needs you right now.">When something does, it shows up here and, if it can't wait, as a notification.</Empty> : null}
          {data.brief ? <BriefPanel brief={data.brief} autoplay={autoplay} /> : null}
          {w.question ? <QuestionCard q={w.question} /> : null}
          {narrow && !expanded ? rest.slice(0, 2) : rest}
          {narrow && !expanded && rest.length > 2 ? (
            <Button kind="quiet" size="sm" className="waiting-more" onClick={() => setExpanded(true)}>
              {`Show ${rest.length - 2} more waiting`}
            </Button>
          ) : null}
        </aside>
      </div>
      {sendAction ? <ConfirmSend action={sendAction} onClose={() => setSendAction(null)} /> : null}
    </div>
  );
}
