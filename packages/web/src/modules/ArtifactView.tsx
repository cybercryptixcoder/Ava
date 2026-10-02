import { useState } from "react";
import type { ArtifactView as Artifact, ExternalActionView } from "@ava/shared";
import { api } from "../lib/api";
import { refetchAll } from "../lib/store";
import { isHidden, useRevealVersion } from "../lib/reveal";
import { Button, ErrorLine, Sheet } from "../components/ui";

export function ArtifactView({ artifact: a, moduleKey }: { artifact: Artifact; moduleKey: string }) {
  useRevealVersion();
  const b = a.body;
  return (
    <div className="artifact" data-kind={b.kind}>
      {a.item_title ? <p className="artifact-for">For {a.item_title}</p> : null}
      {b.kind === "practice_set" ? <PracticeSet intro={b.intro} questions={b.questions} moduleKey={moduleKey} /> : null}
      {b.kind === "draft" ? <Draft artifact={a} /> : null}
      {b.kind === "summary"
        ? b.sections.map((s, i) => (
            <section key={i} className="artifact-section">
              <h4>{s.heading}</h4>
              <p className="voice-sm">{s.text}</p>
            </section>
          ))
        : null}
      {b.kind === "outline"
        ? b.sections.map((s, i) => (
            <section key={i} className="artifact-section">
              <h4>{s.heading}</h4>
              <ul className="artifact-points">
                {s.points.map((p, j) => (
                  <li key={j}>{p}</li>
                ))}
              </ul>
            </section>
          ))
        : null}
      {b.kind === "plan" ? (
        <ol className="artifact-steps">
          {b.steps.map((s, i) => (
            <li key={i}>
              <span>{s.label}</span>
              {s.minutes ? <span className="num artifact-min">{s.minutes} min</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function PracticeSet({ intro, questions, moduleKey }: { intro: string; questions: { q: string; answer: string; hint?: string }[]; moduleKey: string }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  return (
    <>
      <p className="voice-sm artifact-intro">{intro}</p>
      <ol className="practice">
        {questions.map((q, i) => (
          <li key={i} className="practice-q" data-hidden={isHidden(moduleKey, `q${i + 1}`) || undefined}>
            <span className="practice-num num">{i + 1}</span>
            <div className="practice-body">
              <p>{q.q}</p>
              {q.hint && !open.has(i) ? <p className="practice-hint">Hint: {q.hint}</p> : null}
              {open.has(i) ? <p className="practice-answer voice-sm">{q.answer}</p> : null}
              <Button size="sm" kind="quiet" onClick={() => toggle(i)} aria-expanded={open.has(i)}>
                {open.has(i) ? "Hide answer" : "Show answer"}
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

function Draft({ artifact }: { artifact: Artifact }) {
  const b = artifact.body as Extract<Artifact["body"], { kind: "draft" }>;
  const [action, setAction] = useState<ExternalActionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const prepare = async () => {
    setError(null);
    try {
      setAction(await api.post<ExternalActionView>(`/api/artifacts/${artifact.id}/prepare-email`, {}));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="draft">
      <dl className="draft-head">
        <dt>To</dt>
        <dd>{b.to ?? "Not set"}</dd>
        {b.subject ? (
          <>
            <dt>Subject</dt>
            <dd>{b.subject}</dd>
          </>
        ) : null}
      </dl>
      <pre className="draft-body">{b.body}</pre>
      {b.notes ? <p className="draft-notes">{b.notes}</p> : null}
      <div className="row-actions">
        <Button
          size="sm"
          onClick={() =>
            void navigator.clipboard.writeText(b.body).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? "Copied" : "Copy text"}
        </Button>
        <Button size="sm" kind="primary" onClick={() => void prepare()}>
          Review and send
        </Button>
      </div>
      <ErrorLine error={error} />
      {action ? <ConfirmSend action={action} onClose={() => setAction(null)} /> : null}
    </div>
  );
}

/**
 * Every external action is confirmed each time, showing exactly what will be
 * sent and to whom. Editing changes what is shown; the server only sends the
 * exact text confirmed here.
 */
export function ConfirmSend({ action, onClose }: { action: ExternalActionView; onClose: () => void }) {
  const [to, setTo] = useState(action.preview.to);
  const [subject, setSubject] = useState(action.preview.subject);
  const [body, setBody] = useState(action.preview.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const dirty = to !== action.preview.to || subject !== action.preview.subject || body !== action.preview.body;
  const save = async () => {
    await api.patch(`/api/actions/${action.id}`, { to, subject, body });
  };
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      if (dirty) await save();
      const r = await api.post<ExternalActionView>(`/api/actions/${action.id}/confirm`, { to, subject, body });
      setDone(r.status === "executed" ? `Sent to ${r.preview.to}.` : `Not sent: ${r.result ?? r.status}`);
      refetchAll();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    await api.post(`/api/actions/${action.id}/cancel`);
    refetchAll();
    onClose();
  };
  return (
    <Sheet open title="Send this email?" onClose={onClose}>
      {done ? (
        <>
          <p className="voice">{done}</p>
          <Button onClick={onClose}>Close</Button>
        </>
      ) : (
        <form
          className="confirm-send"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <p className="confirm-note">Nothing leaves Ava until you press send. This is exactly what will go out.</p>
          <label className="label" htmlFor="cs-to">
            To
          </label>
          <input id="cs-to" value={to} onChange={(e) => setTo(e.target.value)} inputMode="email" autoComplete="off" required />
          <label className="label" htmlFor="cs-subject">
            Subject
          </label>
          <input id="cs-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          <label className="label" htmlFor="cs-body">
            Message
          </label>
          <textarea id="cs-body" value={body} onChange={(e) => setBody(e.target.value)} rows={10} />
          {!action.available ? <p className="confirm-unavailable">{action.unavailable_reason}</p> : null}
          <ErrorLine error={error} />
          <div className="row-actions">
            <Button kind="primary" type="submit" busy={busy} disabled={!action.available || !to.trim()}>
              Send to {to.trim() || "…"}
            </Button>
            <a className="btn btn-default btn-md" href={`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`}>
              Open in mail app
            </a>
            <Button kind="quiet" type="button" onClick={() => void cancel()}>
              Don't send
            </Button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
