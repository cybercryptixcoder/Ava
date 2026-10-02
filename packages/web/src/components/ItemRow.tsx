import { useState } from "react";
import type { HydratedItem } from "@ava/shared";
import { api } from "../lib/api";
import { refetchAll } from "../lib/store";
import { clock, dayLabel, remaining } from "../lib/time";

const TASK_STATUSES = [
  { value: "todo", label: "Not started" },
  { value: "started", label: "Started" },
  { value: "drafted", label: "Drafted" },
  { value: "almost_done", label: "Almost done" },
  { value: "done", label: "Done" },
];

export function DueCell({ due }: { due: string | null }) {
  if (!due) return <span className="item-due item-due-none">No date</span>;
  const past = new Date(due).getTime() < Date.now();
  return (
    <span className="item-due" data-past={past || undefined} title={new Date(due).toLocaleString()}>
      <span className="item-due-day">{dayLabel(due)}</span>
      <span className="num">{clock(due)}</span>
      <span className="item-due-left num">{past ? remaining(due) : `in ${remaining(due)}`}</span>
    </span>
  );
}

/**
 * One item: check it off (immediately, cancelling its wakes), set where it
 * stands, see when it's due. Used in task lists on the canvas and on the
 * Tasks screen.
 */
export function ItemRow({ item, onEvent, showProject = true, hidden }: { item: HydratedItem; onEvent?: (kind: string, detail: Record<string, unknown>) => void; showProject?: boolean; hidden?: boolean }) {
  const [busy, setBusy] = useState(false);
  const done = ["done", "dropped", "closed", "achieved"].includes(item.status);
  const isTask = item.type === "task";
  const complete = async () => {
    setBusy(true);
    try {
      await api.post(`/api/items/${item.id}/complete`);
      onEvent?.("checked_off", { item_id: item.id, title: item.title });
      refetchAll();
    } finally {
      setBusy(false);
    }
  };
  const setStatus = async (status: string) => {
    setBusy(true);
    try {
      await api.post(`/api/items/${item.id}/status`, { status });
      onEvent?.("status_changed", { item_id: item.id, title: item.title, status });
      refetchAll();
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="item" data-done={done || undefined} data-hidden={hidden || undefined} aria-busy={busy || undefined}>
      <button type="button" className="item-check" role="checkbox" aria-checked={done} aria-label={done ? `${item.title} is done` : `Mark ${item.title} done`} disabled={done || busy} onClick={() => void complete()}>
        <span className="item-check-box" />
      </button>
      <div className="item-main">
        <span className="item-title">{item.title}</span>
        {item.pending_change ? <span className="item-pending">Waiting for your confirmation: {item.pending_change}</span> : null}
        {showProject && item.project_title ? <span className="item-project">{item.project_title}</span> : null}
      </div>
      {isTask ? (
        <label className="item-status">
          <span className="visually-hidden">Where {item.title} stands</span>
          <select value={item.status} disabled={busy} onChange={(e) => void setStatus(e.target.value)}>
            {TASK_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <span className="item-status item-status-text">{item.status_label}</span>
      )}
      <DueCell due={item.due_at} />
    </li>
  );
}
