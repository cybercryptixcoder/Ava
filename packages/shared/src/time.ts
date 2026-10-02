import { DateTime, Interval } from "luxon";

/** The two places Shreyas lives. The current one drives every schedule. */
export interface Location {
  id: string;
  label: string;
  tz: string;
}

export const DEFAULT_LOCATIONS: Location[] = [
  { id: "state-college", label: "State College", tz: "America/New_York" },
  { id: "bangalore", label: "Bangalore", tz: "Asia/Kolkata" },
];

/** "HH:MM" in local time. */
export type LocalTime = string;

export function parseLocalTime(t: LocalTime): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) throw new Error(`Invalid local time "${t}", expected HH:MM`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid local time "${t}"`);
  return { hour, minute };
}

export function toLocal(at: Date | string, tz: string): DateTime {
  const dt = typeof at === "string" ? DateTime.fromISO(at, { zone: "utc" }) : DateTime.fromJSDate(at);
  return dt.setZone(tz);
}

/** Calendar date key (YYYY-MM-DD) of an instant in a time zone. */
export function localDateKey(at: Date | string, tz: string): string {
  return toLocal(at, tz).toISODate()!;
}

/** The instant at which local time `t` occurs on local date `date` in `tz`. */
export function atLocal(date: string, t: LocalTime, tz: string): Date {
  const { hour, minute } = parseLocalTime(t);
  return DateTime.fromISO(date, { zone: tz }).set({ hour, minute, second: 0, millisecond: 0 }).toJSDate();
}

export function minutesOfDay(t: LocalTime): number {
  const { hour, minute } = parseLocalTime(t);
  return hour * 60 + minute;
}

/**
 * Quiet hours wrap midnight when start > end (e.g. 23:00–08:00).
 * Returns true if `at` falls inside quiet hours in `tz`.
 */
export function inQuietHours(at: Date, tz: string, start: LocalTime, end: LocalTime): boolean {
  const local = toLocal(at, tz);
  const m = local.hour * 60 + local.minute;
  const s = minutesOfDay(start);
  const e = minutesOfDay(end);
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** The next instant at or after `at` that is outside quiet hours. */
export function nextWakingInstant(at: Date, tz: string, start: LocalTime, end: LocalTime): Date {
  if (!inQuietHours(at, tz, start, end)) return at;
  const local = toLocal(at, tz);
  const { hour, minute } = parseLocalTime(end);
  let candidate = local.set({ hour, minute, second: 0, millisecond: 0 });
  if (candidate <= local) candidate = candidate.plus({ days: 1 });
  return candidate.toJSDate();
}

/**
 * Number of waking milliseconds between two instants: the time that falls
 * outside quiet hours. Used by the dead-man's switch ("6 waking hours").
 */
export function wakingMsBetween(from: Date, to: Date, tz: string, start: LocalTime, end: LocalTime): number {
  if (to <= from) return 0;
  let total = 0;
  const stepMs = 5 * 60 * 1000;
  for (let t = from.getTime(); t < to.getTime(); t += stepMs) {
    const sliceEnd = Math.min(t + stepMs, to.getTime());
    if (!inQuietHours(new Date(t), tz, start, end)) total += sliceEnd - t;
  }
  return total;
}

export function hoursUntil(from: Date, to: Date | string): number {
  const target = typeof to === "string" ? new Date(to) : to;
  return (target.getTime() - from.getTime()) / 3_600_000;
}

/** Whole local calendar days between `from` and `to` in `tz` (to-date minus from-date). */
export function calendarDaysUntil(from: Date, to: Date | string, tz: string): number {
  const a = toLocal(from, tz).startOf("day");
  const b = toLocal(to, tz).startOf("day");
  return Math.round(b.diff(a, "days").days);
}

export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function intervalMinutes(start: Date | string, end: Date | string): number {
  const s = typeof start === "string" ? DateTime.fromISO(start) : DateTime.fromJSDate(start);
  const e = typeof end === "string" ? DateTime.fromISO(end) : DateTime.fromJSDate(end);
  return Interval.fromDateTimes(s, e).length("minutes") || 0;
}

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export function weekdayOf(at: Date, tz: string): Weekday {
  return WEEKDAYS[toLocal(at, tz).weekday - 1];
}
export const ALL_WEEKDAYS = WEEKDAYS;

/** "1:20 pm" style, for display and speech preparation. */
export function formatClock(at: Date | string, tz: string, opts: { h24?: boolean } = {}): string {
  const l = toLocal(at, tz);
  if (opts.h24) return l.toFormat("HH:mm");
  return l.toFormat(l.minute === 0 ? "h a" : "h:mm a").toLowerCase();
}

/** Human relative phrasing used in "because" lines: "in 2 days", "tomorrow at 9 am". */
export function relativePhrase(now: Date, at: Date | string, tz: string): string {
  const target = typeof at === "string" ? new Date(at) : at;
  const days = calendarDaysUntil(now, target, tz);
  const clock = formatClock(target, tz);
  const mins = Math.round((target.getTime() - now.getTime()) / 60000);
  if (mins < 0) {
    const ago = -mins;
    if (ago < 60) return `${ago} min ago`;
    if (days === 0) return `earlier today at ${clock}`;
    if (days === -1) return `yesterday at ${clock}`;
    return `${-days} days ago`;
  }
  if (mins < 60) return `in ${mins} min`;
  if (days === 0) return `today at ${clock}`;
  if (days === 1) return `tomorrow at ${clock}`;
  if (days < 7) return `${toLocal(target, tz).toFormat("cccc")} at ${clock}`;
  return `in ${days} days`;
}
