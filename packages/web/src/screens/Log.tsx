import { useMemo, useState } from "react";
import type { LogEntry } from "@ava/shared";
import { useApi } from "../lib/store";
import { clock, dayLabel } from "../lib/time";
import { Button, Empty, ErrorLine, Segmented, Sheet } from "../components/ui";

const FILTERS: { value: string; label: string; match: (e: LogEntry) => boolean }[] = [
  { value: "all", label: "Everything", match: () => true },
  { value: "messages", label: "Messages", match: (e) => e.kind.startsWith("message") || e.kind.startsWith("validator") || e.kind.startsWith("push") },
  { value: "rules", label: "Rules", match: (e) => e.kind.startsWith("rule") },
  { value: "model", label: "Model calls", match: (e) => e.kind.startsWith("model") || e.kind.startsWith("budget") },
  { value: "schedule", label: "Schedule", match: (e) => e.kind.startsWith("schedule") || e.kind.startsWith("wake") },
  { value: "problems", label: "Problems", match: (e) => e.level !== "info" },
];

interface Group {
  wake: string | null;
  entries: LogEntry[];
}

const WAKE_NAME: Record<string, string> = {
  heartbeat: "Heartbeat",
  brief: "Morning brief",
  evening: "Evening plan",
  weekly: "Weekly review",
  deadline: "Deadline wake",
  lookahead: "Precise check-in",
  event: "Something changed",
  planner: "Planned check-in",
  rule: "Rule wake",
  executor: "Executor session",
  planning_new: "Planning session",
};

function ModelCall({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error } = useApi<Record<string, unknown>>(`/api/model-calls/${id}`);
  return (
    <Sheet open title="Model call" onClose={onClose} wide>
      <ErrorLine error={error} />
      {data ? (
        <div className="callview">
          <p>
            <span className="label">Purpose</span> {String(data.purpose)} <span className="label">Model</span> {String(data.model)} <span className="label">Status</span> {String(data.status)}
          </p>
          <h3 className="label">Input</h3>
          <pre className="code">{JSON.stringify(data.input, null, 2)}</pre>
          <h3 className="label">Output</h3>
          <pre className="code">{JSON.stringify(data.output, null, 2)}</pre>
        </div>
      ) : null}
    </Sheet>
  );
}

export function Log() {
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const { data, error } = useApi<LogEntry[]>("/api/log?limit=600");
  const [call, setCall] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const f = FILTERS.find((x) => x.value === filter)!;
    const list = (data ?? []).filter((e) => f.match(e) && (!q || e.summary.toLowerCase().includes(q.toLowerCase())));
    // Newest first. Every entry of one wake goes into that wake's group, so each wake reads as one story.
    const out: Group[] = [];
    const byWake = new Map<string, Group>();
    for (const e of list) {
      if (!e.wake_id) {
        out.push({ wake: null, entries: [e] });
        continue;
      }
      let g = byWake.get(e.wake_id);
      if (!g) {
        g = { wake: e.wake_id, entries: [] };
        byWake.set(e.wake_id, g);
        out.push(g);
      }
      g.entries.push(e);
    }
    for (const g of out) g.entries.sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
    return out.sort((a, b) => b.entries[b.entries.length - 1].at.localeCompare(a.entries[a.entries.length - 1].at));
  }, [data, filter, q]);
  if (error) return <ErrorLine error={error} />;
  if (!data) return <div className="screen" aria-busy="true" />;
  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  let lastDay = "";
  return (
    <div className="screen log">
      <header className="screen-head">
        <h1 className="screen-title">Log</h1>
        <p className="screen-sub">Why Ava did or didn't reach out, in order.</p>
      </header>
      <div className="log-tools">
        <Segmented label="Show" value={filter} onChange={setFilter} options={FILTERS.map((f) => ({ value: f.value, label: f.label }))} />
        <label className="log-search">
          <span className="visually-hidden">Search the log</span>
          <input type="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      {!groups.length ? <Empty title="Nothing logged yet for this filter." /> : null}
      <ol className="log-list">
        {groups.map((g, gi) => {
          const first = g.entries[0];
          const day = dayLabel(first.at);
          const showDay = day !== lastDay;
          lastDay = day;
          const start = g.entries.find((e) => e.kind === "wake.start");
          const end = g.entries.find((e) => e.kind === "wake.end");
          const kind = (start?.data as { kind?: string } | null)?.kind;
          const key = `${g.wake ?? "x"}${gi}`;
          const expanded = open.has(key) || !g.wake;
          return (
            <li key={key} className="log-group" data-wake={g.wake ? "true" : undefined}>
              {showDay ? <h2 className="log-day">{day}</h2> : null}
              {g.wake ? (
                <button type="button" className="log-wake" aria-expanded={expanded} onClick={() => toggle(key)}>
                  <span className="num log-time">{clock(first.at)}</span>
                  <span className="log-wake-name">{kind ? WAKE_NAME[kind] ?? kind : "Wake"}</span>
                  <span className="log-wake-outcome">{end ? end.summary.replace(/^.*?finished: /, "") : start?.summary ?? first.summary}</span>
                  <span className="log-wake-n num">{g.entries.length}</span>
                </button>
              ) : null}
              {expanded ? (
                <ol className="log-entries">
                  {g.entries.map((e) => (
                    <li key={e.id} className="log-entry" data-level={e.level} data-kind={e.kind.split(".")[0]}>
                      <span className="num log-time">{clock(e.at)}</span>
                      <span className="log-kind">{e.kind}</span>
                      <span className="log-summary">{e.summary}</span>
                      {e.kind === "model.call" && (e.data as { call_id?: string })?.call_id ? (
                        <Button size="sm" kind="quiet" onClick={() => setCall((e.data as { call_id: string }).call_id)}>
                          Inputs and outputs
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : null}
            </li>
          );
        })}
      </ol>
      {call ? <ModelCall id={call} onClose={() => setCall(null)} /> : null}
    </div>
  );
}
