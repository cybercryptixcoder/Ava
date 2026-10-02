import { useState } from "react";
import type { RuleView, ShadowFiring } from "@ava/shared";
import { api } from "../lib/api";
import { refetchAll, useApi } from "../lib/store";
import { clock, dayLabel, local, now, remaining } from "../lib/time";
import { Button, Empty, ErrorLine, Switch, TickStrip } from "../components/ui";

interface RulesResp {
  constitution: { id: string; name: string; text: string; enforced_by: string }[];
  builtin: RuleView[];
  dynamic: RuleView[];
  proposed: RuleView[];
}

const OUTCOME: Record<ShadowFiring["outcome"], string> = {
  would_message: "Would have messaged you",
  would_queue_for_brief: "Would have waited for the brief",
  blocked_quiet_hours: "Held: quiet hours",
  blocked_class: "Held: you were in class",
  blocked_cap: "Held: daily cap reached",
  blocked_cooldown: "Held: cooldown",
  would_prepare: "Would have prepared work",
  would_wake: "Would have woken Ava",
};

function Shadow({ rule }: { rule: RuleView }) {
  const s = rule.shadow;
  if (!s) return <p className="shadow-none">No shadow run yet.</p>;
  const from = new Date(s.from).getTime();
  const to = new Date(s.to).getTime();
  return (
    <div className="shadow">
      <p className="label">
        Shadow run over {Math.round((to - from) / 86_400_000)} days: {s.firings.length ? `${s.firings.length} time${s.firings.length === 1 ? "" : "s"}` : "it would not have fired"}
      </p>
      <div className="shadow-track" aria-hidden="true">
        {Array.from({ length: Math.round((to - from) / 86_400_000) + 1 }, (_, d) => (
          <span key={d} className="shadow-day" style={{ left: `${(d / Math.max(1, Math.round((to - from) / 86_400_000))) * 100}%` }} />
        ))}
        {s.firings.map((f, i) => (
          <span key={i} className="shadow-mark" data-outcome={f.outcome} style={{ left: `${((new Date(f.at).getTime() - from) / (to - from)) * 100}%` }} />
        ))}
      </div>
      {s.firings.length ? (
        <ul className="shadow-list">
          {s.firings.slice(0, 8).map((f, i) => (
            <li key={i} data-outcome={f.outcome}>
              <span className="num shadow-when">
                {dayLabel(f.at)} {clock(f.at)}
              </span>
              <span>{OUTCOME[f.outcome]}</span>
              <span className="shadow-items">{f.item_titles.join(", ")}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function RuleRow({ rule, proposal }: { rule: RuleView; proposal?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [json, setJson] = useState(() => JSON.stringify(rule.definition, null, 2));
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      refetchAll();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const statusText =
    rule.status === "paused_low_precision"
      ? "Paused itself: you acted on too few of its messages. It comes back in the weekly review with a revision."
      : rule.status === "paused"
        ? "Paused"
        : rule.status === "expired"
          ? "Expired"
          : !rule.enabled
            ? "Off"
            : null;
  return (
    <article className="rule" data-status={rule.status} data-enabled={rule.enabled || undefined}>
      <header className="rule-head">
        <h3 className="rule-name">{rule.name}</h3>
        {!proposal && rule.tier !== "constitution" ? <Switch checked={rule.enabled && rule.status === "active"} label={`${rule.name} on or off`} disabled={busy || ["expired", "rejected"].includes(rule.status)} onChange={(v) => void act(() => api.post(`/api/rules/${rule.id}/enabled`, { enabled: v }))} /> : null}
      </header>
      <p className="voice-sm rule-sentence">{rule.readable}</p>
      {rule.evidence ? (
        <p className="rule-evidence">
          <span className="label">Based on</span> {rule.evidence}
        </p>
      ) : null}
      {rule.params ? (
        <p className="rule-params">
          {Object.entries(rule.params).map(([k, v]) => (
            <span key={k} className="rule-param">
              <span className="label">{k.replace(/_/g, " ")}</span> <span className="num">{Array.isArray(v) ? v.join(", ") : String(v)}</span>
            </span>
          ))}
        </p>
      ) : null}
      <div className="rule-facts">
        <div className="rule-fact">
          <span className="label">Responses</span>
          <TickStrip stats={rule.stats} />
        </div>
        <div className="rule-fact">
          <span className="label">Precision</span>
          <span className="num">{rule.stats.precision === null ? "No data" : `${Math.round(rule.stats.precision * 100)}%`}</span>
        </div>
        <div className="rule-fact">
          <span className="label">Fired</span>
          <span className="num">{rule.stats.fired}</span>
        </div>
        {rule.expires_at ? (
          <div className="rule-fact">
            <span className="label">Expires</span>
            <span className="num" title={local(rule.expires_at).toFormat("ccc d LLL HH:mm")}>
              {new Date(rule.expires_at) > now() ? `in ${remaining(rule.expires_at)}` : "expired"}
            </span>
          </div>
        ) : null}
        <div className="rule-fact">
          <span className="label">Approval</span>
          <span>{rule.approval_tier === "auto" ? "Internal only, auto-approved" : rule.tier === "builtin" ? "Built in" : "Messages you; needs your yes"}</span>
        </div>
      </div>
      {statusText ? <p className="rule-status">{statusText}</p> : null}
      {proposal || rule.status === "proposed" ? <Shadow rule={rule} /> : null}
      {editing ? (
        <form
          className="rule-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api.patch(`/api/rules/${rule.id}`, { definition: JSON.parse(json) });
              setEditing(false);
            });
          }}
        >
          <label className="label" htmlFor={`def-${rule.id}`}>
            Definition
          </label>
          <textarea id={`def-${rule.id}`} className="code" rows={14} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
          <div className="row-actions">
            <Button kind="primary" size="sm" type="submit" busy={busy}>
              Save rule
            </Button>
            <Button size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      <ErrorLine error={error} />
      <div className="row-actions">
        {proposal ? (
          <>
            <Button kind="primary" size="sm" busy={busy} onClick={() => void act(() => api.post(`/api/rules/${rule.id}/approve`))}>
              Approve rule
            </Button>
            <Button size="sm" busy={busy} onClick={() => void act(() => api.post(`/api/rules/${rule.id}/reject`))}>
              Turn down
            </Button>
          </>
        ) : null}
        {rule.status === "paused_low_precision" ? (
          <Button size="sm" busy={busy} onClick={() => void act(() => api.post(`/api/rules/${rule.id}/resume`))}>
            Resume anyway
          </Button>
        ) : null}
        {rule.tier === "dynamic" && !editing ? (
          <Button size="sm" kind="quiet" onClick={() => setEditing(true)}>
            Edit definition
          </Button>
        ) : null}
        {rule.tier === "dynamic" ? (
          <Button size="sm" kind="quiet" busy={busy} onClick={() => void act(() => api.post(`/api/rules/${rule.id}/shadow`, {}))}>
            Run shadow mode
          </Button>
        ) : null}
      </div>
    </article>
  );
}

export function Rules() {
  const { data, error } = useApi<RulesResp>("/api/rules");
  if (error) return <ErrorLine error={error} />;
  if (!data) return <div className="screen" aria-busy="true" />;
  return (
    <div className="screen rules">
      <header className="screen-head">
        <h1 className="screen-title">Rules</h1>
      </header>
      {data.proposed.length ? (
        <section className="band" aria-label="Proposals">
          <h2 className="section-title">Waiting for your yes</h2>
          <p className="band-note">Ava proposed these from what she's seen. Each shows what it would have done over the last few days.</p>
          <div className="rule-list">
            {data.proposed.map((r) => (
              <RuleRow key={r.id} rule={r} proposal />
            ))}
          </div>
        </section>
      ) : null}
      <section className="band" aria-label="Ava's rules">
        <h2 className="section-title">Ava's rules</h2>
        <p className="band-note">Written by Ava for how your life is going right now. Every one expires and has a switch.</p>
        {data.dynamic.length ? (
          <div className="rule-list">
            {data.dynamic.map((r) => (
              <RuleRow key={r.id} rule={r} />
            ))}
          </div>
        ) : (
          <Empty title="No rules of Ava's own yet.">She proposes them during the evening plan and the weekly review.</Empty>
        )}
      </section>
      <section className="band" aria-label="Built-in rules">
        <h2 className="section-title">Built-in rules</h2>
        <div className="rule-list">
          {data.builtin.map((r) => (
            <RuleRow key={r.id} rule={r} />
          ))}
        </div>
      </section>
      <section className="band constitution" aria-label="The constitution">
        <h2 className="section-title">The constitution</h2>
        <p className="band-note">Fixed. Nothing Ava writes can change these; each names where the code enforces it.</p>
        <ol className="articles">
          {data.constitution.map((a, i) => (
            <li key={a.id} className="article">
              <span className="article-num num">{i + 1}</span>
              <div>
                <h3 className="article-name">{a.name}</h3>
                <p className="voice-sm">{a.text}</p>
                <p className="article-code">{a.enforced_by}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
