import { useState } from "react";
import { DateTime } from "luxon";
import type { CalendarDayView, CalendarView, WakeView } from "@ava/shared";
import { useApi } from "../lib/store";
import { clock, now, tz } from "../lib/time";
import { Button, ErrorLine, Segmented } from "../components/ui";

const WAKE_WORDS: Record<string, string> = {
  brief: "Morning stack",
  evening: "Evening plan",
  weekly: "Weekly review",
  deadline: "Deadline check",
  lookahead: "Checking in",
  planner: "Checking in",
  rule: "Checking in",
};

const checkWord = (w: WakeView) => WAKE_WORDS[w.kind] ?? "Checking in";

/** His calendar and Ava's planned check-ins. Day and week. Nothing else. */
export function Calendar() {
  const [view, setView] = useState<"day" | "week">("day");
  const [date, setDate] = useState<string>(() => DateTime.fromJSDate(now()).setZone(tz()).toISODate()!);
  const days = view === "day" ? 1 : 7;
  const { data, error } = useApi<CalendarView>(`/api/calendar?date=${date}&days=${days}`);
  const shift = (n: number) => setDate(DateTime.fromISO(date).plus({ days: n * days }).toISODate()!);
  const today = DateTime.fromJSDate(now()).setZone(tz()).toISODate();
  const title =
    view === "day"
      ? DateTime.fromISO(date).toFormat("cccc d LLLL")
      : `${DateTime.fromISO(date).toFormat("d LLL")} to ${DateTime.fromISO(date).plus({ days: 6 }).toFormat("d LLL")}`;
  return (
    <div className="screen calendar">
      <header className="screen-head calendar-head">
        <h1 className="screen-title">Calendar</h1>
        <div className="calendar-tools">
          <Segmented value={view} options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }]} onChange={(v) => setView(v)} label="Day or week" />
          <div className="calendar-nav">
            <Button size="sm" kind="quiet" onClick={() => shift(-1)}>
              Earlier
            </Button>
            <Button size="sm" kind="quiet" disabled={date === today} onClick={() => setDate(today!)}>
              Today
            </Button>
            <Button size="sm" kind="quiet" onClick={() => shift(1)}>
              Later
            </Button>
          </div>
        </div>
        <p className="screen-sub">{title}</p>
      </header>
      {error ? <ErrorLine error={error} /> : null}
      {!data ? (
        <div aria-busy="true" />
      ) : view === "day" ? (
        <DayView day={data.days[0]} zone={data.tz} today={today!} />
      ) : (
        <WeekView days={data.days} today={today!} />
      )}
    </div>
  );
}

function DayView({ day, zone, today }: { day: CalendarDayView; zone: string; today: string }) {
  const dayStart = DateTime.fromISO(day.date, { zone }).startOf("day");
  const hourOf = (iso: string) => DateTime.fromISO(iso).setZone(zone).diff(dayStart, "minutes").minutes / 60;
  const spans = day.events.flatMap((e) => [hourOf(e.start), hourOf(e.end ?? e.start)]);
  const startHour = Math.max(0, Math.floor(Math.min(8, ...(spans.length ? spans : [8]))));
  const endHour = Math.min(24, Math.ceil(Math.max(23, ...(spans.length ? spans.map((h) => h + 1) : [23]))));
  const hours = endHour - startHour;
  const y = (h: number) => `calc(var(--hour) * ${h - startHour})`;
  const nowMin = DateTime.fromJSDate(now()).setZone(zone).diff(dayStart, "minutes").minutes / 60;
  const isToday = day.date === today;
  const style = { ["--hours" as string]: hours } as React.CSSProperties;
  return (
    <section className="cal-day-wrap" aria-label={`Calendar for ${day.date}`}>
      <div className="cal-day" style={style}>
        <div className="dial-scale" aria-hidden="true">
          {Array.from({ length: hours + 1 }, (_, h) => (
            <div key={h} className="dial-hour" style={{ top: y(startHour + h) }}>
              <span className="dial-num">{String((startHour + h) % 24).padStart(2, "0")}</span>
            </div>
          ))}
          {Array.from({ length: hours * 4 }, (_, q) => (q % 4 === 0 ? null : <div key={q} className={`dial-tick${q % 2 === 0 ? " dial-tick-half" : ""}`} style={{ top: y(startHour + q / 4) }} />))}
        </div>
        <div className="dial-track cal-track" aria-label="Your calendar">
          {day.events.map((e) => {
            const from = Math.max(startHour, hourOf(e.start));
            const to = Math.max(from + 0.34, Math.min(endHour, hourOf(e.end ?? e.start)));
            return (
              <div
                key={e.id}
                className="dial-block"
                data-category={e.category ?? "other"}
                style={{ top: y(from), height: `calc(var(--hour) * ${to - from})` }}
                title={`${e.title}, ${clock(e.start)}${e.end ? ` to ${clock(e.end)}` : ""}${e.location ? `, ${e.location}` : ""}`}
              >
                <span className="dial-block-time num">
                  {e.all_day ? "All day" : `${clock(e.start)}${e.end ? `–${clock(e.end)}` : ""}`}
                </span>
                <span className="dial-block-title">{e.title}</span>
                {e.location && to - from >= 0.8 ? <span className="dial-block-detail">{e.location}</span> : null}
              </div>
            );
          })}
        </div>
        <div className="cal-checks" aria-label="Ava's check-ins">
          {day.check_ins.map((c) => (
            <div key={c.id} className="cal-check" data-kind={c.kind} data-status={c.status} style={{ top: y(hourOf(c.due_at)) }} title={c.reason}>
              <span className="cal-check-mark" aria-hidden="true" />
              <span className="cal-check-label">
                <span className="num">{clock(c.due_at)}</span> {checkWord(c)}
              </span>
            </div>
          ))}
        </div>
        {isToday && nowMin >= startHour && nowMin <= endHour ? (
          <div className="cal-now" style={{ top: y(nowMin) }} aria-label="Now">
            <span className="cal-now-time num">{clock(now())}</span>
          </div>
        ) : null}
      </div>
      {day.events.length === 0 && day.check_ins.length === 0 ? <p className="cal-empty">An open day.</p> : null}
    </section>
  );
}

function WeekView({ days, today }: { days: CalendarDayView[]; today: string }) {
  return (
    <div className="week">
      {days.map((d) => (
        <div key={d.date} className="week-day" data-today={d.date === today || undefined}>
          <p className="week-label">{DateTime.fromISO(d.date).toFormat("ccc d")}</p>
          <ul className="week-entries">
            {d.events.length === 0 && d.check_ins.length === 0 ? <li className="week-empty">Open</li> : null}
            {d.events.map((e) => (
              <li key={e.id} className="week-entry" data-kind="event" data-category={e.category ?? "other"} title={e.location ?? undefined}>
                <span className="num">{e.all_day ? "All day" : clock(e.start)}</span> {e.title}
              </li>
            ))}
            {d.check_ins.map((c) => (
              <li key={c.id} className="week-entry" data-kind="wake" title={c.reason}>
                <span className="num">{clock(c.due_at)}</span> {checkWord(c)}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
