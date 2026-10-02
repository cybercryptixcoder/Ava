import { DateTime } from "luxon";
import { BELIEF_AREAS, type KnowsView, type LatencySample, type UsageView } from "@ava/shared";
import type { Services } from "../core/services";
import { j } from "../db/db";

export function knowsView(svc: Services): KnowsView {
  const all = svc.beliefs.list({ status: ["active", "proposed"] });
  const areas = Array.from(new Set([...BELIEF_AREAS, ...all.map((b) => b.area)]));
  return { beliefs: all.filter((b) => b.status === "active"), proposed: all.filter((b) => b.status === "proposed"), areas };
}

export function usageView(svc: Services): UsageView {
  const { db, counters, settings } = svc;
  const date = counters.today();
  const tz = settings.tz();
  const start = DateTime.fromISO(date, { zone: tz }).startOf("day").toUTC().toISO()!;
  const by = db.all<{ purpose: string; calls: number; cost: number; ms: number }>(
    "SELECT purpose, COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(AVG(latency_ms), 0) AS ms FROM model_calls WHERE at >= ? GROUP BY purpose ORDER BY calls DESC",
    [start],
  );
  const recent = db.all<{ id: string; at: string; purpose: string; model: string; latency_ms: number | null; cost_usd: number | null; status: string; usage: string | null }>(
    "SELECT id, at, purpose, model, latency_ms, cost_usd, status, usage FROM model_calls ORDER BY at DESC LIMIT 40",
  );
  const b = settings.get().budgets;
  return {
    date,
    calls_system: counters.get("model.calls.system"),
    calls_interactive: counters.get("model.calls.interactive"),
    cost_usd: Math.round(counters.get("model.cost_usd") * 10000) / 10000,
    budget: { system_calls: b.system_calls, interactive_calls: b.interactive_calls, usd: b.usd },
    by_purpose: by.map((r) => ({ purpose: r.purpose, calls: r.calls, cost_usd: Math.round(r.cost * 10000) / 10000, avg_ms: Math.round(r.ms) })),
    recent: recent.map((r) => ({
      id: r.id,
      at: r.at,
      purpose: r.purpose,
      model: r.model,
      ms: r.latency_ms ?? 0,
      cost_usd: r.cost_usd ?? 0,
      status: r.status,
      cache_read: j<{ cache_read_input_tokens?: number }>(r.usage, {}).cache_read_input_tokens ?? 0,
    })),
  };
}

export function latencyView(svc: Services): { samples: LatencySample[]; summary: { model: string; n: number; p50: number | null; p90: number | null; stages: Record<string, number> }[] } {
  const rows = svc.db.all<{ id: string; at: string; mode: string; model: string; tts: string; stt: string; stages: string; total_ms: number | null }>(
    "SELECT * FROM latency_samples ORDER BY at DESC LIMIT 200",
  );
  const samples: LatencySample[] = rows.map((r) => ({ id: r.id, at: r.at, mode: r.mode as "live", model: r.model, tts: r.tts, stt: r.stt, stages: j(r.stages, {}), total_ms: r.total_ms }));
  const models = Array.from(new Set(samples.map((s) => s.model)));
  const pct = (xs: number[], p: number) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  };
  return {
    samples,
    summary: models.map((m) => {
      const ss = samples.filter((s) => s.model === m);
      const totals = ss.map((s) => s.total_ms).filter((x): x is number => x !== null && x >= 0);
      const stageKeys = Array.from(new Set(ss.flatMap((s) => Object.keys(s.stages))));
      const stages: Record<string, number> = {};
      for (const k of stageKeys) {
        const vals = ss.map((s) => s.stages[k]).filter((v) => typeof v === "number" && v >= 0);
        if (vals.length) stages[k] = pct(vals, 50)!;
      }
      return { model: m, n: ss.length, p50: pct(totals, 50), p90: pct(totals, 90), stages };
    }),
  };
}
