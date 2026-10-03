import { DateTime } from "luxon";
import type { HydratedData } from "@ava/shared";
import type { Services } from "../core/services";

type Metric = "work" | "study" | "sleep" | "active";

const WORK_CATS = new Set(["work", "coding", "writing", "research", "admin"]);
const STUDY_CATS = new Set(["study", "coursework", "reading", "lecture"]);

/**
 * Rhythms: when Shreyas actually works, studies, is active and sleeps,
 * computed statistically from activity sessions and his interactions with
 * Ava. Never guessed. Strong, stable patterns become observed-belief
 * proposals with the numbers attached as evidence.
 */
export class Rhythms {
  constructor(private svc: Services) {}

  private sessions(fromIso: string) {
    return this.svc.db.all<{ started_at: string; ended_at: string; active_seconds: number; category: string | null }>(
      "SELECT started_at, ended_at, active_seconds, category FROM activity_sessions WHERE started_at >= ? ORDER BY started_at",
      [fromIso],
    );
  }

  /** Timestamps of Shreyas's own interactions: turns, responses, check-offs. */
  private interactions(fromIso: string): Date[] {
    const { db } = this.svc;
    const rows = [
      ...db.all<{ at: string }>("SELECT recorded_at AS at FROM entries WHERE kind = 'turn' AND role = 'user' AND recorded_at >= ?", [fromIso]),
      ...db.all<{ at: string }>("SELECT responded_at AS at FROM messages WHERE responded_at >= ?", [fromIso]),
      ...db.all<{ at: string }>("SELECT at FROM item_history WHERE via NOT IN ('gcal','ics','system') AND at >= ?", [fromIso]),
    ];
    return rows.map((r) => new Date(r.at)).sort((a, b) => a.getTime() - b.getTime());
  }

  /** Minutes per weekday (Mon=0) × hour for a metric. */
  grid(metric: Metric, days: number): { grid: number[][]; sampleDays: number } {
    const tz = this.svc.settings.tz();
    const now = this.svc.clock.now();
    const from = new Date(now.getTime() - days * 86_400_000);
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
    const seenDays = new Set<string>();
    if (metric === "sleep") {
      // Sleep: the longest gap with no activity or interaction between 20:00 and 13:00 each night.
      const marks = [...this.sessions(from.toISOString()).flatMap((s) => [new Date(s.started_at), new Date(s.ended_at)]), ...this.interactions(from.toISOString())].sort(
        (a, b) => a.getTime() - b.getTime(),
      );
      for (let d = 0; d < days; d++) {
        const night = DateTime.fromJSDate(from).setZone(tz).startOf("day").plus({ days: d, hours: 20 });
        const end = night.plus({ hours: 17 });
        const inWin = marks.filter((m) => m >= night.toJSDate() && m <= end.toJSDate());
        if (inWin.length < 2) continue;
        let best: [Date, Date] | null = null;
        const pts = [night.toJSDate(), ...inWin, end.toJSDate()];
        for (let i = 1; i < pts.length; i++) {
          const gap = pts[i].getTime() - pts[i - 1].getTime();
          if (gap >= 3 * 3_600_000 && (!best || gap > best[1].getTime() - best[0].getTime())) best = [pts[i - 1], pts[i]];
        }
        if (!best) continue;
        seenDays.add(night.toISODate()!);
        for (let t = best[0].getTime(); t < best[1].getTime(); t += 60_000) {
          const l = DateTime.fromMillis(t).setZone(tz);
          grid[l.weekday - 1][l.hour] += 1;
        }
      }
      return { grid, sampleDays: seenDays.size };
    }
    for (const s of this.sessions(from.toISOString())) {
      if (metric === "work" && !WORK_CATS.has(s.category ?? "")) continue;
      if (metric === "study" && !STUDY_CATS.has(s.category ?? "")) continue;
      const start = new Date(s.started_at).getTime();
      const end = new Date(s.ended_at).getTime();
      const span = Math.max(1, end - start);
      const activeRatio = Math.min(1, (s.active_seconds * 1000) / span);
      for (let t = start; t < end; t += 60_000) {
        const l = DateTime.fromMillis(t).setZone(tz);
        grid[l.weekday - 1][l.hour] += activeRatio;
        seenDays.add(l.toISODate()!);
      }
    }
    return { grid: grid.map((r) => r.map((v) => Math.round(v))), sampleDays: seenDays.size };
  }

  view(metric: Metric, days = 28): Extract<HydratedData, { type: "rhythm_view" }> {
    const { grid, sampleDays } = this.grid(metric, days);
    const byHour = Array.from({ length: 24 }, (_, h) => grid.reduce((n, row) => n + row[h], 0));
    return { type: "rhythm_view", metric, days, grid, by_hour: byHour, summary: this.summarize(metric, byHour, sampleDays), sample_days: sampleDays };
  }

  private summarize(metric: Metric, byHour: number[], sampleDays: number): string {
    const total = byHour.reduce((a, b) => a + b, 0);
    if (!total || sampleDays < 3) return `Not enough data yet (${sampleDays} day${sampleDays === 1 ? "" : "s"} with ${metric} data).`;
    // Find the contiguous 3-hour window with the most minutes.
    let best = 0,
      bestStart = 0;
    for (let h = 0; h < 24; h++) {
      const w = byHour[h] + byHour[(h + 1) % 24] + byHour[(h + 2) % 24];
      if (w > best) {
        best = w;
        bestStart = h;
      }
    }
    const share = Math.round((best / total) * 100);
    const fmt = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;
    const label = metric === "sleep" ? "asleep" : metric === "active" ? "on the laptop" : metric === "study" ? "studying" : "working";
    return `Most often ${label} between ${fmt(bestStart)} and ${fmt(bestStart + 3)} (${share}% of ${Math.round(total / 60)} hours over ${sampleDays} days).`;
  }

  /** Recompute rhythm items and propose observed beliefs for strong patterns. */
  recompute(): void {
    const { items, proposals, beliefs, log, db } = this.svc;
    for (const metric of ["work", "study", "sleep", "active"] as Metric[]) {
      const v = this.view(metric, 28);
      if (v.sample_days < 5) continue;
      const title = `${metric[0].toUpperCase()}${metric.slice(1)} rhythm`;
      const existing = items.list({ types: ["rhythm"] }).find((r) => r.data.metric === metric);
      const data = { metric, by_hour: v.by_hour, summary: v.summary, sample_days: v.sample_days };
      if (existing) items.update(existing.id, { data, status: "current" }, "rhythms", { touch: false });
      else items.create({ type: "rhythm", title, data, status: "current" }, { source: "rhythms" });
      const statement = v.summary.replace(/^Most often/, "You are most often");
      const already = beliefs.list({ area: "routines" }).some((b) => b.statement.startsWith(statement.slice(0, 40)));
      const pendingAlready = db.get("SELECT id FROM proposals WHERE status = 'pending' AND origin = 'rhythms' AND summary LIKE ?", [`%${metric}%`]);
      if (!already && !pendingAlready && /\(\d+%/.test(v.summary) && Number(/\((\d+)%/.exec(v.summary)![1]) >= 35) {
        proposals.createBatch("rhythms", [
          {
            change: { op: "add_belief", belief: { area: "routines", statement, provenance: "observed", confidence: 0.7 } },
            summary: `Observed ${metric} rhythm: ${statement}`,
            reason: `Computed from ${v.sample_days} days of data`,
          },
        ]);
        log.info("rhythm.proposed", `Proposed an observed ${metric} rhythm: ${statement}`);
      }
    }
  }

  activityNow(): { active_minutes_last_hour: number | null; current_category: string | null } {
    const { db, clock, settings } = this.svc;
    if (!settings.get().sources.activity) return { active_minutes_last_hour: null, current_category: null };
    const since = new Date(clock.now().getTime() - 3_600_000).toISOString();
    const rows = db.all<{ active_seconds: number; category: string | null; ended_at: string }>(
      "SELECT active_seconds, category, ended_at FROM activity_sessions WHERE ended_at >= ? ORDER BY ended_at DESC",
      [since],
    );
    if (!rows.length) return { active_minutes_last_hour: 0, current_category: null };
    return { active_minutes_last_hour: Math.round(rows.reduce((n, r) => n + r.active_seconds, 0) / 60), current_category: rows[0].category };
  }
}
