import { useState } from "react";
import type { Belief } from "@ava/shared";
import { api } from "../lib/api";
import { refetchAll } from "../lib/store";
import { dayLabel } from "../lib/time";
import { Button, Meter } from "./ui";

/** One belief: statement, provenance, decaying confidence, confirm/edit/remove. */
export function BeliefRow({ belief: b, hidden }: { belief: Belief; hidden?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(b.statement);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      refetchAll();
    } finally {
      setBusy(false);
    }
  };
  const prov = b.status === "proposed" ? "Inferred, unconfirmed" : b.provenance === "inferred" ? "Inferred, confirmed by you" : b.provenance === "observed" ? "Observed from data" : "Stated by you";
  return (
    <li className="belief" data-prov={b.provenance} data-status={b.status} data-hidden={hidden || undefined}>
      {editing ? (
        <form
          className="belief-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.patch(`/api/beliefs/${b.id}`, { statement: text })).then(() => setEditing(false));
          }}
        >
          <label className="visually-hidden" htmlFor={`b-${b.id}`}>
            Belief
          </label>
          <textarea id={`b-${b.id}`} value={text} onChange={(e) => setText(e.target.value)} rows={2} />
          <div className="row-actions">
            <Button kind="primary" size="sm" type="submit" busy={busy}>
              Save
            </Button>
            <Button size="sm" type="button" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <p className="belief-statement">{b.statement}</p>
      )}
      <div className="belief-meta">
        <span className="belief-prov">{prov}</span>
        <Meter value={b.effective_confidence} label={`Confidence ${Math.round(b.effective_confidence * 100)}%`} />
        <span className="num belief-conf">{Math.round(b.effective_confidence * 100)}%</span>
        <span className="belief-when">{b.last_confirmed_at ? `Confirmed ${dayLabel(b.last_confirmed_at).replace(/^(Today|Yesterday|Tomorrow)$/, (w) => w.toLowerCase())}` : "Never confirmed"}</span>
      </div>
      {!editing ? (
        <div className="row-actions">
          <Button size="sm" kind={b.status === "proposed" ? "primary" : "default"} busy={busy} onClick={() => void run(() => api.post(`/api/beliefs/${b.id}/confirm`))}>
            {b.status === "proposed" ? "Confirm" : "Still true"}
          </Button>
          <Button size="sm" kind="quiet" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button size="sm" kind="quiet" busy={busy} onClick={() => void run(() => api.del(`/api/beliefs/${b.id}`))}>
            Remove
          </Button>
        </div>
      ) : null}
    </li>
  );
}
