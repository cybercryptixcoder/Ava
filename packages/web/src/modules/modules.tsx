import { useState } from "react";
import { DateTime } from "luxon";
import type { HydratedData, HydratedModule, Proposal } from "@ava/shared";
import { api } from "../lib/api";
import { refetchAll } from "../lib/store";
import { isHidden, useRevealVersion } from "../lib/reveal";
import { clock, dayLabel, now, remaining, tz } from "../lib/time";
import { Button, Meter, TickStrip } from "../components/ui";
import { DueCell, ItemRow } from "../components/ItemRow";
import { ArtifactView } from "./ArtifactView";

type D<T extends HydratedData["type"]> = Extract<HydratedData, { type: T }>;
export interface ModCtx {
  conversationId: string | null;
  moduleKey: string;
  onEvent: (kind: string, detail: Record<string, unknown>) => void;
}

export function TaskListModule({ data, ctx }: { data: D<"task_list">; ctx: ModCtx }) {
  useRevealVersion();
  if (!data.items.length) return <p className="mod-empty">Nothing here right now.</p>;
  return (
    <ul className="items">
      {data.items.map((i) => (
        <ItemRow key={i.id} item={i} onEvent={ctx.onEvent} hidden={isHidden(ctx.moduleKey, i.id)} />
      ))}
    </ul>
  );
}

export function OptionsModule({ data, ctx }: { data: D<"options">; ctx: ModCtx }) {
  useRevealVersion();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const choose = async (key: string) => {
    if (!ctx.conversationId) return;
    setBusy(key);
    try {
      const r = await api.post<{ result: { summary: string } }>(`/api/canvas/${ctx.moduleKey}/option`, { conversation_id: ctx.conversationId, option: key });
      setResult(r.result.summary);
      refetchAll();
    } catch (e) {
      setResult((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="opts">
      {data.prompt ? <p className="opts-prompt">{data.prompt}</p> : null}
      <ol className="opts-list">
        {data.options.map((o, i) => {
          const chosen = data.chosen === o.key;
          return (
            <li key={o.key} className="opt" data-recommended={data.recommended === o.key || undefined} data-chosen={chosen || undefined} data-hidden={isHidden(ctx.moduleKey, o.key) || undefined}>
              <button type="button" className="opt-btn" disabled={!!busy || !!data.chosen} onClick={() => void choose(o.key)} aria-describedby={o.detail ? `${ctx.moduleKey}-${o.key}-d` : undefined}>
                <span className="opt-num num">{i + 1}</span>
                <span className="opt-text">
                  <span className="opt-label">{o.label}</span>
                  {o.detail ? (
                    <span className="opt-detail" id={`${ctx.moduleKey}-${o.key}-d`}>
                      {o.detail}
                    </span>
                  ) : null}
                </span>
                {data.recommended === o.key && !data.chosen ? <span className="opt-pick">Ava would pick this</span> : null}
                {chosen ? <span className="opt-pick">Chosen</span> : null}
                {busy === o.key ? <span className="opt-pick">Starting</span> : null}
              </button>
            </li>
          );
        })}
      </ol>
      {result ? <p className="mod-result">{result}</p> : null}
    </div>
  );
}

export function DeadlineHorizonModule({ data, ctx }: { data: D<"deadline_horizon">; ctx: ModCtx }) {
  useRevealVersion();
  const span = data.days * 24;
  if (!data.items.length) return <p className="mod-empty">Nothing due in the next {data.days} days.</p>;
  return (
    <div className="horizon">
      <div className="horizon-scale" aria-hidden="true">
        {Array.from({ length: data.days + 1 }, (_, d) => (
          <span key={d} className="horizon-tick" data-week={d % 7 === 0 || undefined} style={{ left: `${(d / data.days) * 100}%` }}>
            {d % 7 === 0 ? <span className="horizon-tick-label num">{d === 0 ? "now" : `${d} d`}</span> : null}
          </span>
        ))}
      </div>
      <ul className="horizon-rows">
        {data.items.map((i) => (
          <li key={i.id} className="horizon-row" data-hidden={isHidden(ctx.moduleKey, i.id) || undefined}>
            <div className="horizon-label">
              <span className="horizon-title">{i.title}</span>
              <span className="horizon-prep" data-prep={i.prep}>
                <span className="prep-mark" aria-hidden="true" />
                {i.status_label}
              </span>
            </div>
            <div className="horizon-track">
              <span className="horizon-bar" style={{ width: `${Math.min(100, Math.max(0.8, (i.hours_left / span) * 100))}%` }} />
              <span className="horizon-left num">{remaining(i.due_at!)}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ProjectCardModule({ data, ctx }: { data: D<"project_card">; ctx: ModCtx }) {
  const p = data.project;
  return (
    <div className="project">
      <div className="project-facts">
        <div>
          <span className="label">Status</span>
          <span>{p.status_label}</span>
        </div>
        <div>
          <span className="label">Last touched</span>
          <span className="num">{data.days_since_touched === 0 ? "Today" : `${data.days_since_touched} d ago`}</span>
        </div>
        <div className="project-next">
          <span className="label">Next step</span>
          <span className="voice-sm">{p.next_step ?? "Not set"}</span>
        </div>
      </div>
      {data.tasks.length ? (
        <ul className="items">
          {data.tasks.map((t) => (
            <ItemRow key={t.id} item={t} onEvent={ctx.onEvent} showProject={false} />
          ))}
        </ul>
      ) : null}
      {data.open_loops.length ? (
        <>
          <p className="label project-sub">Open loops</p>
          <ul className="items">
            {data.open_loops.map((t) => (
              <ItemRow key={t.id} item={t} onEvent={ctx.onEvent} showProject={false} />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export function ComparisonModule({ data, ctx }: { data: D<"comparison_table">; ctx: ModCtx }) {
  useRevealVersion();
  return (
    <div className="cmp-wrap">
      <table className="cmp">
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Option</span>
            </th>
            {data.columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.key} data-recommended={data.recommended_row === r.key || undefined} data-hidden={isHidden(ctx.moduleKey, r.key) || undefined}>
              <th scope="row">
                {r.label}
                {data.recommended_row === r.key ? <span className="cmp-pick">Ava would pick this</span> : null}
              </th>
              {r.cells.map((c, i) => (
                <td key={i}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RuleCardModule({ data }: { data: D<"rule_card"> }) {
  return <RuleSummary rule={data.rule} />;
}

export function RuleSummary({ rule }: { rule: D<"rule_card">["rule"] }) {
  const [busy, setBusy] = useState(false);
  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    try {
      await api.post(path, body);
      refetchAll();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rulecard">
      <p className="voice-sm rulecard-sentence">{rule.readable}</p>
      {rule.evidence ? (
        <p className="rulecard-evidence">
          <span className="label">Based on</span> {rule.evidence}
        </p>
      ) : null}
      <div className="rulecard-stats">
        <TickStrip stats={rule.stats} />
        <span className="num rulecard-precision">{rule.stats.precision === null ? "No responses yet" : `Precision ${Math.round(rule.stats.precision * 100)}%`}</span>
      </div>
      {rule.status === "proposed" ? (
        <div className="row-actions">
          <Button kind="primary" size="sm" busy={busy} onClick={() => void act(`/api/rules/${rule.id}/approve`)}>
            Approve rule
          </Button>
          <Button size="sm" busy={busy} onClick={() => void act(`/api/rules/${rule.id}/reject`)}>
            Turn down
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function BeliefCardModule({ data, ctx }: { data: D<"belief_card">; ctx: ModCtx }) {
  useRevealVersion();
  if (!data.beliefs.length) return <p className="mod-empty">Nothing recorded in this area yet.</p>;
  return (
    <ul className="beliefs">
      {data.beliefs.map((b) => (
        <BeliefRow key={b.id} belief={b} hidden={isHidden(ctx.moduleKey, b.id)} />
      ))}
    </ul>
  );
}

export function BeliefRow({ belief: b, hidden }: { belief: D<"belief_card">["beliefs"][number]; hidden?: boolean }) {
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

export function ChipsModule({ data, ctx }: { data: D<"confirmation_chips">; ctx: ModCtx }) {
  useRevealVersion();
  const pending = data.proposals.filter((p) => p.status === "pending");
  const [busy, setBusy] = useState(false);
  const batch = async (decision: "accept" | "reject") => {
    setBusy(true);
    try {
      await api.post(`/api/proposals/batch/${data.batch_id}`, { decision });
      ctx.onEvent(decision === "accept" ? "accepted_all" : "rejected_all", { batch: data.batch_id, count: pending.length });
      refetchAll();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="chips">
      <ul className="chips-list">
        {data.proposals.map((p) => (
          <ChipRow key={p.id} p={p} hidden={isHidden(ctx.moduleKey, p.id)} onEvent={ctx.onEvent} />
        ))}
      </ul>
      {pending.length > 1 ? (
        <div className="row-actions">
          <Button kind="primary" size="sm" busy={busy} onClick={() => void batch("accept")}>
            Accept all {pending.length}
          </Button>
          <Button size="sm" busy={busy} onClick={() => void batch("reject")}>
            Reject all
          </Button>
        </div>
      ) : null}
    </div>
  );
}

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

export function NoteModule({ data, ctx }: { data: D<"note">; ctx: ModCtx }) {
  useRevealVersion();
  return (
    <div className="note" data-tone={data.tone}>
      {data.paragraphs.map((p, i) => (
        <p key={i} className="voice-sm" data-hidden={isHidden(ctx.moduleKey, `p${i + 1}`) || undefined}>
          {p}
        </p>
      ))}
    </div>
  );
}

const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function RhythmModule({ data }: { data: D<"rhythm_view"> }) {
  const max = Math.max(1, ...data.grid.flat());
  const [hover, setHover] = useState<string | null>(null);
  return (
    <div className="rhythm">
      <p className="rhythm-summary">{data.summary}</p>
      <div className="rhythm-grid" role="table" aria-label={`${data.metric} minutes by weekday and hour`}>
        <div className="rhythm-row rhythm-head" role="row">
          <span role="columnheader" />
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} role="columnheader" className="rhythm-hour num">
              {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
            </span>
          ))}
        </div>
        {data.grid.map((row, d) => (
          <div key={d} className="rhythm-row" role="row">
            <span role="rowheader" className="rhythm-day">
              {WEEK[d]}
            </span>
            {row.map((v, h) => (
              <span
                key={h}
                role="cell"
                className="rhythm-cell"
                style={{ ["--v" as string]: v / max }}
                aria-label={`${WEEK[d]} ${String(h).padStart(2, "0")}:00, ${v} minutes`}
                onMouseEnter={() => setHover(`${WEEK[d]} ${String(h).padStart(2, "0")}:00 to ${String((h + 1) % 24).padStart(2, "0")}:00: ${v} min`)}
                onMouseLeave={() => setHover(null)}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="rhythm-foot">
        <span className="rhythm-legend" aria-hidden="true">
          <span className="label">Less</span>
          {[0.1, 0.3, 0.55, 0.8, 1].map((v) => (
            <span key={v} className="rhythm-cell" style={{ ["--v" as string]: v }} />
          ))}
          <span className="label">More</span>
        </span>
        <span className="rhythm-hover num" aria-live="polite">
          {hover ?? `${data.sample_days} days of data`}
        </span>
      </div>
    </div>
  );
}

/** A single-series chart: thin bars or a 2 px line, a hairline baseline, clean ticks, hover readout, table view. */
export function ChartModule({ data }: { data: D<"chart"> }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = Math.max(1, ...data.points.map((p) => p.value));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const W = 560,
    H = 180,
    padL = 34,
    padB = 22,
    padT = 10;
  const n = data.points.length;
  const band = (W - padL) / n;
  const barW = Math.min(24, band * 0.6);
  const yv = (v: number) => padT + (H - padT - padB) * (1 - v / top);
  const last = data.points[n - 1];
  if (table)
    return (
      <div className="chart">
        <table className="cmp chart-table">
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">
                Value ({data.unit})
              </th>
            </tr>
          </thead>
          <tbody>
            {data.points.map((p) => (
              <tr key={p.date}>
                <th scope="row">{DateTime.fromISO(p.date).toFormat("ccc d LLL")}</th>
                <td className="num">{p.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Button size="sm" kind="quiet" onClick={() => setTable(false)}>
          Show chart
        </Button>
      </div>
    );
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label={`${data.metric.replace(/_/g, " ")} per day, latest ${last?.value ?? 0} ${data.unit}`}>
        {Array.from({ length: top / step + 1 }, (_, i) => (
          <g key={i}>
            <line x1={padL} x2={W} y1={yv(i * step)} y2={yv(i * step)} className={i === 0 ? "chart-base" : "chart-grid"} />
            <text x={padL - 6} y={yv(i * step) + 4} className="chart-tick" textAnchor="end">
              {i * step}
            </text>
          </g>
        ))}
        {data.points.map((p, i) => {
          const cx = padL + band * i + band / 2;
          return (
            <g key={p.date} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={padL + band * i} y={padT} width={band} height={H - padT - padB} fill="transparent" />
              {data.kind === "bar" && p.value > 0 ? <path className="chart-bar" d={roundTop(cx - barW / 2, yv(p.value), barW, yv(0) - yv(p.value))} data-hover={hover === i || undefined} /> : null}
              {i % Math.ceil(n / 7) === 0 || i === n - 1 ? (
                <text x={cx} y={H - 6} className="chart-tick" textAnchor="middle">
                  {DateTime.fromISO(p.date).toFormat("d LLL")}
                </text>
              ) : null}
            </g>
          );
        })}
        {data.kind === "line" ? (
          <polyline className="chart-line" points={data.points.map((p, i) => `${padL + band * i + band / 2},${yv(p.value)}`).join(" ")} />
        ) : null}
        {data.kind === "line" && last ? <circle className="chart-dot" cx={padL + band * (n - 1) + band / 2} cy={yv(last.value)} r={4} /> : null}
        {last ? (
          <text x={Math.min(W - 4, padL + band * (n - 1) + band / 2)} y={yv(last.value) - 8} className="chart-value" textAnchor="end">
            {last.value}
          </text>
        ) : null}
      </svg>
      <div className="chart-foot">
        <span className="num" aria-live="polite">
          {hover !== null ? `${DateTime.fromISO(data.points[hover].date).toFormat("ccc d LLL")}: ${data.points[hover].value} ${data.unit}` : `Latest: ${last?.value ?? 0} ${data.unit}`}
        </span>
        <Button size="sm" kind="quiet" onClick={() => setTable(true)}>
          Show as table
        </Button>
      </div>
    </div>
  );
}

function niceStep(max: number): number {
  const raw = max / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function roundTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

export function WeekModule({ data }: { data: D<"week_view"> }) {
  const today = DateTime.fromJSDate(now()).setZone(data.tz).toISODate();
  return (
    <div className="week">
      {data.days.map((d) => (
        <div key={d.date} className="week-day" data-today={d.date === today || undefined}>
          <p className="week-label">{d.label}</p>
          <ul className="week-entries">
            {d.entries.length === 0 ? <li className="week-empty">Open</li> : null}
            {d.entries.map((e) => (
              <li key={e.id} className="week-entry" data-kind={e.kind} data-category={e.category}>
                <span className="num">{clock(e.start)}</span> {e.kind === "deadline" ? `Due: ${e.title}` : e.title}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function ModuleBody({ m, ctx }: { m: HydratedModule; ctx: ModCtx }) {
  const d = m.data;
  switch (d.type) {
    case "task_list":
      return <TaskListModule data={d} ctx={ctx} />;
    case "options":
      return <OptionsModule data={d} ctx={ctx} />;
    case "deadline_horizon":
      return <DeadlineHorizonModule data={d} ctx={ctx} />;
    case "project_card":
      return <ProjectCardModule data={d} ctx={ctx} />;
    case "artifact_preview":
      return <ArtifactView artifact={d.artifact} moduleKey={ctx.moduleKey} />;
    case "comparison_table":
      return <ComparisonModule data={d} ctx={ctx} />;
    case "rule_card":
      return <RuleCardModule data={d} />;
    case "belief_card":
      return <BeliefCardModule data={d} ctx={ctx} />;
    case "confirmation_chips":
      return <ChipsModule data={d} ctx={ctx} />;
    case "note":
      return <NoteModule data={d} ctx={ctx} />;
    case "rhythm_view":
      return <RhythmModule data={d} />;
    case "chart":
      return <ChartModule data={d} />;
    case "week_view":
      return <WeekModule data={d} />;
    case "day_timeline":
      return null;
  }
}

export { DueCell };
