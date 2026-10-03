import { useState } from "react";
import type { ConfigReport, LatencySample, UsageView } from "@ava/shared";
import { api } from "../lib/api";
import { refetchAll, useApi } from "../lib/store";
import { clock, dayLabel, local } from "../lib/time";
import { playSpeech } from "../lib/reveal";
import { Button, Empty, ErrorLine } from "../components/ui";

interface Latency {
  samples: LatencySample[];
  summary: { model: string; n: number; p50: number | null; p90: number | null; stages: Record<string, number> }[];
}
interface Clock {
  now: string;
  simulated: boolean;
  profile: string;
  tz: string;
}
interface PRun {
  id: string;
  created_at: string;
  voice_hash: string;
  label: string | null;
  results: { id: string; title: string; mode: string; input: string; reply: string; words: number; checks: { name: string; ok: boolean; detail: string }[]; audio_id: string | null; ms: number }[];
}
interface MemoryStatus {
  entries: number;
  by_kind: Record<string, number>;
  episodes: number;
  facts: number;
  pending: number;
  backfill: {
    phase: string;
    copied: { turns: number; evidence: number; history: number };
    skipped_purged: number;
    errors: number;
    finished_at: string | null;
  };
}

const STAGE_LABEL: Record<string, string> = {
  eot_detect_ms: "End of speech to end of turn",
  grace_hold_ms: "Held for an unfinished thought",
  tts_connect_ms: "Voice connection",
  llm_ttft_ms: "Model first token",
  first_sentence_ms: "First sentence ready",
  tts_first_audio_ms: "First audio from voice",
  server_first_audio_ms: "Server: turn end to first audio",
  client_playback_ms: "You: turn end to sound",
  llm_total_ms: "Model total",
};

export function ConfigSection() {
  const { data, error } = useApi<ConfigReport>("/api/config/report");
  if (error) return <ErrorLine error={error} />;
  if (!data) return <div aria-busy="true" />;
  return (
    <div className="config">
      <p className="band-note">Profile: {data.profile === "test" ? "test (fixture data, simulated clock)" : "real"}</p>
      <ul className="features">
        {data.features.map((f) => (
          <li key={f.id} className="feature" data-on={f.enabled || undefined}>
            <span className="feature-state">{f.enabled ? "On" : "Off"}</span>
            <span className="feature-name">{f.label}</span>
            {f.reason ? <span className="feature-reason">{f.reason}</span> : null}
          </li>
        ))}
      </ul>
      <details className="config-keys">
        <summary>Keys and settings</summary>
        <ul>
          {data.items.map((i) => (
            <li key={i.key} data-present={i.present || undefined}>
              <code>{i.key}</code> <span>{i.present ? "present" : i.required ? "missing (required)" : "not set"}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export function DevSection() {
  const { data: usage } = useApi<UsageView>("/api/dev/usage");
  const { data: lat } = useApi<Latency>("/api/dev/latency");
  const { data: clk } = useApi<Clock>("/api/dev/clock");
  const { data: pstat } = useApi<{ stale: boolean; cases: number; voice_hash: string; last_run_hash: string | null }>("/api/personality/status");
  const { data: runs } = useApi<PRun[]>("/api/personality/runs");
  const { data: mem } = useApi<MemoryStatus>("/api/memory/status");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ran, setRan] = useState<{ kind: string; due_at: string }[]>([]);
  const [compare, setCompare] = useState<[string | null, string | null]>([null, null]);
  const act = async (k: string, fn: () => Promise<unknown>) => {
    setBusy(k);
    setError(null);
    try {
      await fn();
      refetchAll();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const advance = (hours: number) =>
    act(`adv${hours}`, async () => {
      const r = await api.post<{ ran: { kind: string; due_at: string }[] }>("/api/dev/clock/advance", { hours });
      setRan(r.ran);
    });
  const runA = runs?.find((r) => r.id === compare[0]) ?? runs?.[1];
  const runB = runs?.find((r) => r.id === compare[1]) ?? runs?.[0];
  return (
    <div className="dev">
      <ErrorLine error={error} />
      <section className="band" aria-label="Time simulation">
        <h3 className="section-title">Time simulation</h3>
        {clk?.simulated ? (
          <>
            <p className="band-note">
              Simulated clock: <span className="num">{local(clk.now).toFormat("ccc d LLL HH:mm")}</span> ({clk.tz}). Advancing runs every wake at its own time, so you can watch rules fire, the validator decide and briefs compose.
            </p>
            <div className="row-actions">
              {[1, 3, 12, 24, 24 * 7].map((h) => (
                <Button key={h} size="sm" busy={busy === `adv${h}`} onClick={() => void advance(h)}>
                  {h < 24 ? `Forward ${h} h` : h === 24 ? "Forward a day" : "Forward a week"}
                </Button>
              ))}
            </div>
            {ran.length ? (
              <ol className="sim-ran">
                {ran.map((w, i) => (
                  <li key={i}>
                    <span className="num">
                      {dayLabel(w.due_at)} {clock(w.due_at)}
                    </span>{" "}
                    {w.kind}
                  </li>
                ))}
              </ol>
            ) : null}
          </>
        ) : (
          <p className="band-note">Time simulation runs on the test profile only (start it with npm run dev:test). Your real data always runs on the real clock.</p>
        )}
        <div className="row-actions">
          {(["heartbeat", "brief", "evening", "weekly"] as const).map((k) => (
            <Button key={k} size="sm" kind="quiet" busy={busy === k} onClick={() => void act(k, () => api.post("/api/dev/wake", { kind: k }))}>
              Run {k === "brief" ? "the morning brief" : k === "evening" ? "the evening plan" : k === "weekly" ? "the weekly review" : "a heartbeat"} now
            </Button>
          ))}
        </div>
      </section>

      <section className="band" aria-label="Memory">
        <h3 className="section-title">Memory</h3>
        {mem ? (
          <>
            <p className="band-note">
              Raw log: <span className="num">{mem.entries}</span> entries · <span className="num">{mem.episodes}</span> episodes · <span className="num">{mem.facts}</span> facts
              {mem.pending ? ` · ${mem.pending} waiting to process` : ""}.{" "}
              {mem.backfill.phase === "done"
                ? mem.backfill.copied.turns + mem.backfill.copied.evidence + mem.backfill.copied.history === 0
                  ? "Nothing older needed importing; the log starts from now."
                  : `Everything older was imported (${mem.backfill.copied.turns} turns, ${mem.backfill.copied.evidence} sourced records, ${mem.backfill.copied.history} item events${mem.backfill.skipped_purged ? `; ${mem.backfill.skipped_purged} records were purged before the log existed and can't be recovered` : ""}).`
                : `Still importing older data (${mem.backfill.phase}, ${mem.backfill.copied.turns + mem.backfill.copied.evidence + mem.backfill.copied.history} copied so far).`}
            </p>
            {mem.backfill.phase !== "done" ? (
              <div className="row-actions">
                <Button size="sm" kind="quiet" busy={busy === "backfill"} onClick={() => void act("backfill", () => api.post("/api/memory/backfill", {}))}>
                  Finish the import now
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </section>

      <section className="band" aria-label="Model usage">
        <h3 className="section-title">Model usage today</h3>
        {usage ? (
          <>
            <div className="usage-tiles">
              <div className="tile">
                <span className="label">Ava's own calls</span>
                <span className="tile-value num">
                  {usage.calls_system}
                  <span className="tile-of"> of {usage.budget.system_calls}</span>
                </span>
              </div>
              <div className="tile">
                <span className="label">Calls you started</span>
                <span className="tile-value num">
                  {usage.calls_interactive}
                  <span className="tile-of"> of {usage.budget.interactive_calls}</span>
                </span>
              </div>
              <div className="tile">
                <span className="label">Spend</span>
                <span className="tile-value num">
                  ${usage.cost_usd.toFixed(2)}
                  <span className="tile-of"> of ${usage.budget.usd.toFixed(2)}</span>
                </span>
              </div>
            </div>
            {usage.by_purpose.length ? (
              <table className="cmp">
                <thead>
                  <tr>
                    <th scope="col">Purpose</th>
                    <th scope="col">Calls</th>
                    <th scope="col">Average time</th>
                    <th scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.by_purpose.map((p) => (
                    <tr key={p.purpose}>
                      <th scope="row">{p.purpose}</th>
                      <td className="num">{p.calls}</td>
                      <td className="num">{p.avg_ms} ms</td>
                      <td className="num">${p.cost_usd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="band-note">No model calls today.</p>
            )}
          </>
        ) : null}
      </section>

      <section className="band" aria-label="Live latency">
        <h3 className="section-title">Live mode latency</h3>
        <p className="band-note">Target: under about 800 ms from the end of your turn to Ava's first sound. Every stage is timed; the benchmark (npm run bench:voice) adds controlled runs.</p>
        {lat?.summary.length ? (
          <table className="cmp">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Turns</th>
                <th scope="col">Median</th>
                <th scope="col">90th percentile</th>
                {Object.keys(STAGE_LABEL).map((k) => (
                  <th key={k} scope="col">
                    {STAGE_LABEL[k]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lat.summary.map((s) => (
                <tr key={s.model}>
                  <th scope="row">{s.model}</th>
                  <td className="num">{s.n}</td>
                  <td className="num" data-over={s.p50 !== null && s.p50 > 800 ? "true" : undefined}>
                    {s.p50 ?? "–"} ms
                  </td>
                  <td className="num">{s.p90 ?? "–"} ms</td>
                  {Object.keys(STAGE_LABEL).map((k) => (
                    <td key={k} className="num">
                      {s.stages[k] !== undefined ? `${Math.round(s.stages[k])} ms` : "–"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="No live turns measured yet.">Have a live conversation or run npm run bench:voice; each turn's stages show up here.</Empty>
        )}
      </section>

      <section className="band" aria-label="Personality test set">
        <h3 className="section-title">Personality test set</h3>
        <p className="band-note">
          {pstat ? `${pstat.cases} sample conversations. ${pstat.stale ? "The voice files changed since the last run; run the set again." : "The last run used the current voice files."}` : ""}
        </p>
        <div className="row-actions">
          <Button size="sm" busy={busy === "prun"} onClick={() => void act("prun", () => api.post("/api/personality/run", { audio: false }))}>
            Run the test set
          </Button>
          <Button size="sm" kind="quiet" busy={busy === "pruna"} onClick={() => void act("pruna", () => api.post("/api/personality/run", { audio: true }))}>
            Run with audio
          </Button>
        </div>
        {runs && runs.length ? (
          <>
            <div className="row-actions">
              <label className="label">
                Compare
                <select value={runA?.id ?? ""} onChange={(e) => setCompare([e.target.value, compare[1]])}>
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {dayLabel(r.created_at)} {clock(r.created_at)} {r.label ?? ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="label">
                with
                <select value={runB?.id ?? ""} onChange={(e) => setCompare([compare[0], e.target.value])}>
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {dayLabel(r.created_at)} {clock(r.created_at)} {r.label ?? ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="pruns">
              {(runB ?? runA)!.results.map((r) => {
                const a = runA?.results.find((x) => x.id === r.id);
                return (
                  <div key={r.id} className="prun-case">
                    <h4 className="prun-title">{r.title}</h4>
                    <p className="prun-input">{r.input}</p>
                    <div className="prun-cols">
                      {[a, r].map((x, i) =>
                        x ? (
                          <div key={i} className="prun-col">
                            <p className="voice-sm">{x.reply}</p>
                            <p className="prun-checks">
                              {x.checks.filter((c) => !c.ok).length ? x.checks.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`).join("; ") : "All checks passed"}
                            </p>
                            {x.audio_id ? (
                              <Button size="sm" kind="quiet" onClick={() => playSpeech(x.audio_id!, [])}>
                                Play
                              </Button>
                            ) : null}
                          </div>
                        ) : (
                          <div key={i} className="prun-col" />
                        ),
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
