import { useEffect, useMemo, useRef, useState } from "react";
import type { HydratedData, TimelineEntry } from "@ava/shared";
import { DateTime } from "luxon";
import { api } from "../lib/api";
import { refetchAll } from "../lib/store";
import { clock, clock12, now } from "../lib/time";
import { isHidden, useRevealVersion } from "../lib/reveal";
import { Button } from "../components/ui";

type Data = Extract<HydratedData, { type: "day_timeline" }>;

interface Placed {
  e: TimelineEntry;
  top: number;
  height: number;
  lane: number;
  lanes: number;
}

const WAKE_WORDS: Record<string, string> = {
  heartbeat: "Heartbeat",
  brief: "Morning brief",
  evening: "Evening plan",
  weekly: "Weekly review",
  deadline: "Deadline check",
  lookahead: "Checking in",
  planner: "Checking in",
  rule: "Checking in",
  executor: "Preparing",
  planning_new: "Planning",
};

function lanesFor(list: { start: number; end: number; e: TimelineEntry }[]): Placed[] {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const out: Placed[] = [];
  let group: typeof sorted = [];
  let groupEnd = -1;
  const flush = () => {
    const laneEnds: number[] = [];
    const placed = group.map((g) => {
      let lane = laneEnds.findIndex((end) => end <= g.start);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(g.end);
      } else laneEnds[lane] = g.end;
      return { g, lane };
    });
    for (const p of placed) out.push({ e: p.g.e, top: p.g.start, height: Math.max(p.g.end - p.g.start, 18), lane: p.lane, lanes: laneEnds.length });
    group = [];
  };
  for (const s of sorted) {
    if (group.length && s.start >= groupEnd) {
      flush();
      groupEnd = -1;
    }
    group.push(s);
    groupEnd = Math.max(groupEnd, s.end);
  }
  if (group.length) flush();
  return out;
}

/**
 * The day as a vertical dial: hour numerals and quarter ticks, his calendar
 * on the first track, Ava's track (her planned wakes and intended work) in
 * steel beside it, and the now-hand across both.
 */
export function DayTimeline({ data, moduleKey, compact = false }: { data: Data; moduleKey: string; compact?: boolean }) {
  useRevealVersion();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((x) => x + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const hourPx = compact ? 40 : undefined;
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<string | null>(null);

  const day = DateTime.fromISO(data.date, { zone: data.tz });
  const [wh] = data.waking.start.split(":").map(Number);
  const [qh] = data.waking.end.split(":").map(Number);
  const startHour = Math.min(wh, ...data.entries.map((e) => DateTime.fromISO(e.start).setZone(data.tz).hour));
  const endHour = Math.max(qh === 0 ? 24 : qh, ...data.entries.map((e) => Math.min(24, DateTime.fromISO(e.end ?? e.start).setZone(data.tz).hour + 1)));
  const dayStart = day.set({ hour: startHour });
  const hours = Math.max(6, endHour - startHour);
  const toMin = (iso: string) => DateTime.fromISO(iso).setZone(data.tz).diff(dayStart, "minutes").minutes;

  const his = data.entries.filter((e) => e.kind === "event");
  const ava = data.entries.filter((e) => e.kind === "plan" || e.kind === "pending_change");
  const wakes = data.entries.filter((e) => e.kind === "wake" && e.category !== "heartbeat");
  const beats = data.entries.filter((e) => e.kind === "wake" && e.category === "heartbeat");
  const flags = data.entries.filter((e) => e.kind === "deadline");

  const placedHis = useMemo(() => lanesFor(his.map((e) => ({ e, start: toMin(e.start), end: toMin(e.end ?? e.start) }))), [data]);
  const placedAva = useMemo(() => lanesFor(ava.map((e) => ({ e, start: toMin(e.start), end: toMin(e.end ?? e.start) }))), [data]);
  const nowMin = toMin(now().toISOString());
  const showNow = nowMin >= 0 && nowMin <= hours * 60;

  useEffect(() => {
    if (!ref.current || compact) return;
    const el = ref.current.querySelector(".dial-now");
    if (el && "scrollIntoView" in el) (el as HTMLElement).scrollIntoView({ block: "center" });
  }, [compact]);

  const style = { ["--hours" as string]: hours, ...(hourPx ? { ["--hour" as string]: `${hourPx}px` } : {}) };
  const y = (min: number) => `calc(var(--hour) * ${min / 60})`;

  const moveWake = async (id: string, minutes: number) => {
    await api.post(`/api/wakes/${id}/snooze`, { minutes });
    setMenu(null);
    refetchAll();
  };
  const cancelWake = async (id: string) => {
    await api.post(`/api/wakes/${id}/cancel`);
    setMenu(null);
    refetchAll();
  };

  return (
    <div className={`dial${compact ? " dial-compact" : ""}`} style={style} ref={ref} aria-label={`Timeline for ${day.toFormat("cccc d LLLL")}`}>
      <div className="dial-scale" aria-hidden="true">
        {Array.from({ length: hours + 1 }, (_, h) => (
          <div key={h} className="dial-hour" style={{ top: y(h * 60) }}>
            <span className="dial-num">{String((startHour + h) % 24).padStart(2, "0")}</span>
          </div>
        ))}
        {Array.from({ length: hours * 4 }, (_, q) =>
          q % 4 === 0 ? null : <div key={q} className={`dial-tick${q % 2 === 0 ? " dial-tick-half" : ""}`} style={{ top: y(q * 15) }} />,
        )}
      </div>

      <div className="dial-track dial-his" aria-label="Your calendar">
        {placedHis.map((p) => (
          <div
            key={p.e.id}
            className="dial-block"
            data-category={p.e.category}
            data-highlight={p.e.highlighted || undefined}
            data-hidden={isHidden(moduleKey, p.e.id) || undefined}
            style={{ top: y(p.top), height: y(p.height), left: `calc(${(p.lane / p.lanes) * 100}% + 1px)`, width: `calc(${100 / p.lanes}% - 3px)` }}
            title={`${p.e.title} ${clock(p.e.start)}–${p.e.end ? clock(p.e.end) : ""}`}
          >
            <span className="dial-block-time num">{clock(p.e.start)}</span>
            <span className="dial-block-title">{p.e.title}</span>
            {p.e.detail && p.height >= 44 ? <span className="dial-block-detail">{p.e.detail}</span> : null}
          </div>
        ))}
        {flags.map((f) => (
          <div key={f.id} className="dial-flag" data-hidden={isHidden(moduleKey, f.id) || undefined} style={{ top: y(toMin(f.start)) }}>
            <span className="dial-flag-label">
              <span className="num">{clock(f.start)}</span> Due: {f.title}
            </span>
          </div>
        ))}
      </div>

      <div className="dial-track dial-ava" aria-label="Ava's plan">
        {placedAva.map((p) => (
          <div
            key={p.e.id}
            className={`dial-plan${p.e.kind === "pending_change" ? " dial-ghost" : ""}`}
            data-highlight={p.e.highlighted || undefined}
            data-hidden={isHidden(moduleKey, p.e.id) || undefined}
            style={{ top: y(p.top), height: y(p.height), left: `calc(${(p.lane / p.lanes) * 100}% + 1px)`, width: `calc(${100 / p.lanes}% - 3px)` }}
          >
            <span className="dial-block-time num">{clock(p.e.start)}</span>
            <span className="dial-block-title">{p.e.kind === "pending_change" ? `Moving here: ${p.e.title}` : p.e.title}</span>
            {p.e.detail && p.height >= 44 ? <span className="dial-block-detail">{p.e.detail}</span> : null}
          </div>
        ))}
        {beats.map((b) => (
          <div key={b.id} className="dial-beat" style={{ top: y(toMin(b.start)) }} title={`Heartbeat ${clock(b.start)}`} aria-hidden="true" />
        ))}
        {wakes.map((w) => {
          const label = `${WAKE_WORDS[w.category ?? ""] ?? "Checking in"} at ${clock12(w.start)}`;
          return (
            <div key={w.id} className="dial-wake" data-status={w.status} data-hidden={isHidden(moduleKey, w.id) || undefined} style={{ top: y(toMin(w.start)) }}>
              <span className="dial-wake-mark" aria-hidden="true" />
              {w.movable && !compact ? (
                <button type="button" className="dial-wake-label" aria-haspopup="menu" aria-expanded={menu === w.id} onClick={() => setMenu(menu === w.id ? null : w.id)} title={w.title}>
                  <span className="num">{clock(w.start)}</span> {w.title}
                </button>
              ) : (
                <span className="dial-wake-label" title={label}>
                  <span className="num">{clock(w.start)}</span> {w.title}
                </span>
              )}
              {menu === w.id ? (
                <div className="popover dial-menu" role="menu">
                  <p className="popover-note">{label}</p>
                  <Button size="sm" role="menuitem" onClick={() => void moveWake(w.wake_id!, -30)}>
                    30 min earlier
                  </Button>
                  <Button size="sm" role="menuitem" onClick={() => void moveWake(w.wake_id!, 30)}>
                    30 min later
                  </Button>
                  <Button size="sm" role="menuitem" onClick={() => void moveWake(w.wake_id!, 120)}>
                    2 hours later
                  </Button>
                  <Button size="sm" kind="danger" role="menuitem" onClick={() => void cancelWake(w.wake_id!)}>
                    Cancel this check-in
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {showNow ? (
        <div className="dial-now" style={{ top: y(nowMin) }} aria-label={`Now, ${clock(now())}`}>
          <span className="dial-now-time num">{clock(now())}</span>
        </div>
      ) : null}
    </div>
  );
}
