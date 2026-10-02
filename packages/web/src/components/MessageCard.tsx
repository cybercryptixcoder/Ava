import { useState } from "react";
import type { MessageView, ResponseKind } from "@ava/shared";
import { RESPONSE_LABELS } from "@ava/shared";
import { api } from "../lib/api";
import { refetchAll } from "../lib/store";
import { ago, clock, dayLabel } from "../lib/time";
import { Button } from "./ui";

/**
 * A proactive message: the point first, the because line built from real
 * items, 2–4 options that start the work, and the four one-tap responses.
 */
export function MessageCard({ m, compact }: { m: MessageView; compact?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const respond = async (response: ResponseKind, option?: string) => {
    setBusy(option ?? response);
    try {
      const r = await api.post<{ result: { summary: string } | null }>(`/api/messages/${m.id}/respond`, { response, option });
      setResult(r.result?.summary ?? RESPONSE_LABELS[response]);
      refetchAll();
    } catch (e) {
      setResult((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const answered = !!m.response || m.acted;
  return (
    <article className="msg" data-kind={m.kind} data-status={m.status} data-answered={answered || undefined} aria-label={m.headline}>
      <header className="msg-head">
        <h3 className="msg-headline">{m.headline}</h3>
        <span className="msg-when num" title={m.created_at}>
          {m.status === "queued" ? "Waiting for the brief" : m.sent_at ? `${dayLabel(m.sent_at)} ${clock(m.sent_at)}` : ago(m.created_at)}
        </span>
      </header>
      {m.kind === "weekly_review" ? (
        m.because.split("\n\n").map((p, i) => (
          <p key={i} className="voice-sm msg-para">
            {p}
          </p>
        ))
      ) : m.because ? (
        <p className="msg-because">
          <span className="label">Because</span> {m.because}
        </p>
      ) : null}
      {!compact && m.rule_name ? (
        <p className="msg-rule">
          <span className="label">Rule</span> {m.rule_name}
          {m.drafted_by === "fallback_template" ? <span className="msg-drafted">, worded from a template</span> : null}
        </p>
      ) : null}
      {m.options.length && !answered && m.kind !== "alert" ? (
        <div className="msg-options">
          {m.options.map((o, i) => (
            <Button key={o.key} size="sm" kind={i === 0 ? "primary" : "default"} busy={busy === o.key} disabled={!!busy} onClick={() => void respond("do_it", o.key)}>
              {o.label}
            </Button>
          ))}
        </div>
      ) : null}
      {!answered && m.kind === "nudge" ? (
        <div className="msg-responses" role="group" aria-label="Respond">
          {((m.options.length ? ["not_now", "already_done", "less_of_this"] : ["do_it", "not_now", "already_done", "less_of_this"]) as ResponseKind[]).map((r) => (
            <button key={r} type="button" className="msg-response" disabled={!!busy} onClick={() => void respond(r)}>
              {RESPONSE_LABELS[r]}
            </button>
          ))}
        </div>
      ) : null}
      {answered ? (
        <p className="msg-answered">
          {m.response ? `You answered: ${RESPONSE_LABELS[m.response]}${m.response_option ? ` (${m.options.find((o) => o.key === m.response_option)?.label ?? m.response_option})` : ""}` : "You acted on it"}
          {m.responded_at ? <span className="num"> {clock(m.responded_at)}</span> : null}
        </p>
      ) : null}
      {result ? <p className="mod-result">{result}</p> : null}
    </article>
  );
}
