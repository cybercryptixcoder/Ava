import { DateTime } from "luxon";

/** Formatting for the instrument: tabular, consistent, in the current time zone. */
let currentTz = "America/New_York";
let nowOffsetMs = 0;

export function setTimeContext(tz: string, serverNow?: string) {
  currentTz = tz;
  if (serverNow) nowOffsetMs = new Date(serverNow).getTime() - Date.now();
}

export function tz(): string {
  return currentTz;
}

/** "Now" as the server sees it (the test profile runs a simulated clock). */
export function now(): Date {
  return new Date(Date.now() + nowOffsetMs);
}

export function local(iso: string | Date): DateTime {
  return (typeof iso === "string" ? DateTime.fromISO(iso) : DateTime.fromJSDate(iso)).setZone(currentTz);
}

/** 24-hour clock, the dial's native format: "13:20". */
export function clock(iso: string | Date): string {
  return local(iso).toFormat("HH:mm");
}

/** Spoken-style clock for sentences: "1:20 pm". */
export function clock12(iso: string | Date): string {
  const l = local(iso);
  return l.toFormat(l.minute === 0 ? "h a" : "h:mm a").toLowerCase();
}

export function dayLabel(iso: string | Date): string {
  const l = local(iso).startOf("day");
  const today = local(now()).startOf("day");
  const d = Math.round(l.diff(today, "days").days);
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  if (d === -1) return "Yesterday";
  if (d > 1 && d < 7) return l.toFormat("cccc");
  return l.toFormat("ccc d LLL");
}

export function when(iso: string | Date): string {
  const label = dayLabel(iso);
  return `${label} ${clock(iso)}`;
}

/** Remaining time as a compact duration: "2 d 4 h", "45 min". */
export function remaining(iso: string): string {
  const ms = new Date(iso).getTime() - now().getTime();
  const past = ms < 0;
  const m = Math.abs(ms) / 60_000;
  let s: string;
  if (m < 60) s = `${Math.round(m)} min`;
  else if (m < 48 * 60) s = `${Math.floor(m / 60)} h${Math.round(m % 60) ? ` ${Math.round(m % 60)} min` : ""}`;
  else s = `${Math.floor(m / 1440)} d${Math.floor((m % 1440) / 60) ? ` ${Math.floor((m % 1440) / 60)} h` : ""}`;
  return past ? `${s} ago` : s;
}

export function ago(iso: string): string {
  const ms = now().getTime() - new Date(iso).getTime();
  const m = ms / 60_000;
  if (m < 1) return "just now";
  if (m < 60) return `${Math.round(m)} min ago`;
  if (m < 24 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

export function placeTime(zone: string): string {
  return DateTime.fromJSDate(now()).setZone(zone).toFormat("HH:mm");
}
