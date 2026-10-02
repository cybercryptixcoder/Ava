import { useState } from "react";
import { DateTime } from "luxon";
import type { Proposal } from "@ava/shared";
import { api } from "../lib/api";
import { refetchAll } from "../lib/store";
import { tz } from "../lib/time";
import { Button } from "./ui";

/** One proposal from an import review queue: accept, edit the title and due, or reject. */
export function ChipRow({ p, hidden, onEvent }: { p: Proposal; hidden?: boolean; onEvent?: (k: string, d: Record<string, unknown>) => void }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const c = p.change;
  const editable = c.op === "create_item";
  const [title, setTitle] = useState(c.op === "create_item" ? c.item.title : "");
  const [due, setDue] = useState(c.op === "create_item" && c.item.due_at ? DateTime.fromISO(c.item.due_at).setZone(tz()).toFormat("yyyy-LL-dd'T'HH:mm") : "");
  const act = async (accept: boolean, edited?: unknown) => {
    setBusy(true);
    try {
      await api.post(`/api/proposals/${p.id}/${accept ? "accept" : "reject"}`, edited ? { change: edited } : {});
      onEvent?.(accept ? "accepted_chip" : "rejected_chip", { summary: p.summary });
      refetchAll();
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="chip" data-status={p.status} data-hidden={hidden || undefined}>
      {editing && c.op === "create_item" ? (
        <form
          className="chip-edit"
          onSubmit={(e) => {
            e.preventDefault();
            const dueIso = due ? DateTime.fromISO(due, { zone: tz() }).toUTC().toISO() : null;
            void act(true, { ...c, item: { ...c.item, title, due_at: dueIso } });
          }}
        >
          <label className="label" htmlFor={`t-${p.id}`}>
            Title
          </label>
          <input id={`t-${p.id}`} value={title} onChange={(e) => setTitle(e.target.value)} />
          <label className="label" htmlFor={`d-${p.id}`}>
            Due
          </label>
          <input id={`d-${p.id}`} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
          <div className="row-actions">
            <Button kind="primary" size="sm" type="submit" busy={busy}>
              Accept edited
            </Button>
            <Button size="sm" type="button" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="chip-main">
            <span className="chip-summary">{p.summary}</span>
            {p.reason ? <span className="chip-reason">“{p.reason}”</span> : null}
          </div>
          {p.status === "pending" ? (
            <div className="chip-actions">
              <Button size="sm" busy={busy} onClick={() => void act(true)}>
                Accept
              </Button>
              {editable ? (
                <Button size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              ) : null}
              <Button size="sm" kind="quiet" busy={busy} onClick={() => void act(false)}>
                Reject
              </Button>
            </div>
          ) : (
            <span className="chip-state">{p.status === "accepted" ? "Accepted" : p.status === "rejected" ? "Rejected" : "Replaced"}</span>
          )}
        </>
      )}
    </li>
  );
}
