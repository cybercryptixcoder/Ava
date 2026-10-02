import { gzipSync, gunzipSync, strToU8, strFromU8 } from "fflate";
import {
  calendarDaysUntil,
  inQuietHours,
  isClosed,
  toLocal,
  weekdayOf,
  type Item,
  type ItemType,
} from "@ava/shared";

/**
 * A compact, immutable picture of the world at one instant. Rules evaluate
 * against this, never against live stores, so evaluation is deterministic
 * and the same snapshot can be replayed later for shadow mode.
 */
export interface WorldItem {
  id: string;
  type: ItemType;
  title: string;
  status: string;
  due_at: string | null;
  start_at: string | null;
  end_at: string | null;
  project_id: string | null;
  importance: number | null;
  tags: string[];
  kind: string | null;
  course: string | null;
  estimate_minutes: number | null;
  important: boolean;
  to_person: string | null;
  event_kind: string | null;
  busy: boolean;
  touched_at: string;
  status_changed_at: string;
  created_at: string;
  completed_at: string | null;
}

export interface FreeBlock {
  start: string;
  end: string;
  minutes: number;
  after_event_id: string | null;
  before_event_id: string | null;
}

export interface WorldState {
  at: string;
  tz: string;
  location_id: string;
  quiet: { start: string; end: string };
  items: WorldItem[];
  /** Planned work blocks from the latest plan. */
  plan_blocks: { id: string; item_id: string | null; title: string; start_at: string; end_at: string }[];
  activity: { active_minutes_last_hour: number | null; current_category: string | null };
  messages_today: number;
}

export function toWorldItem(i: Item): WorldItem {
  const d = i.data as Record<string, unknown>;
  return {
    id: i.id,
    type: i.type,
    title: i.title,
    status: i.status,
    due_at: i.due_at,
    start_at: i.start_at,
    end_at: i.end_at,
    project_id: i.project_id,
    importance: i.importance,
    tags: i.tags,
    kind: (d.kind as string) ?? null,
    course: (d.course as string) ?? null,
    estimate_minutes: typeof d.estimate_minutes === "number" ? d.estimate_minutes : null,
    important: d.important === true || (i.type === "project" && (i.importance ?? 0) >= 2),
    to_person: (d.to_person as string) ?? (d.counterpart as string) ?? null,
    event_kind: (d.kind as string) ?? null,
    busy: d.busy !== false,
    touched_at: i.touched_at,
    status_changed_at: i.status_changed_at,
    created_at: i.created_at,
    completed_at: i.completed_at,
  };
}

export function encodeSnapshot(w: WorldState): string {
  return Buffer.from(gzipSync(strToU8(JSON.stringify(w)))).toString("base64");
}

export function decodeSnapshot(s: string): WorldState {
  return JSON.parse(strFromU8(gunzipSync(Buffer.from(s, "base64"))));
}

// ---------------------------------------------------------------------------
// Derived facts
// ---------------------------------------------------------------------------

export const CLASS_KINDS = new Set(["class", "exam", "lecture", "lab", "quiz", "midterm", "final"]);

export function isClassEvent(e: WorldItem): boolean {
  if (e.type !== "event") return false;
  if (e.event_kind && CLASS_KINDS.has(e.event_kind)) return true;
  return e.tags.some((t) => CLASS_KINDS.has(t));
}

export function eventsAround(w: WorldState, from: Date, to: Date): WorldItem[] {
  return w.items
    .filter((i) => i.type === "event" && i.status !== "cancelled" && i.start_at && i.end_at)
    .filter((e) => new Date(e.start_at!) < to && new Date(e.end_at!) > from)
    .sort((a, b) => a.start_at!.localeCompare(b.start_at!));
}

export function currentEvent(w: WorldState, now: Date): WorldItem | null {
  return eventsAround(w, now, new Date(now.getTime() + 1)).find((e) => e.busy) ?? null;
}

/** Class or exam blocks happening at `now` (the constitution forbids messages during these). */
export function inClassBlock(w: WorldState, now: Date): WorldItem | null {
  return eventsAround(w, now, new Date(now.getTime() + 1)).find(isClassEvent) ?? null;
}

/**
 * Free blocks: gaps between busy events, clipped to waking hours, within
 * the next `horizonHours`.
 */
export function freeBlocks(w: WorldState, now: Date, horizonHours = 18): FreeBlock[] {
  const end = new Date(now.getTime() + horizonHours * 3_600_000);
  const busy = eventsAround(w, now, end).filter((e) => e.busy);
  const blocks: FreeBlock[] = [];
  let cursor = now;
  let prevId: string | null = null;
  const push = (s: Date, e: Date, before: string | null) => {
    // Clip the gap to waking hours: walk minute-steps of 5.
    let segStart: Date | null = null;
    for (let t = s.getTime(); t <= e.getTime(); t += 5 * 60_000) {
      const d = new Date(Math.min(t, e.getTime()));
      const quiet = inQuietHours(d, w.tz, w.quiet.start, w.quiet.end);
      if (!quiet && !segStart) segStart = d;
      if ((quiet || t >= e.getTime()) && segStart) {
        const segEnd = quiet ? d : e;
        const minutes = Math.round((segEnd.getTime() - segStart.getTime()) / 60_000);
        if (minutes > 0) blocks.push({ start: segStart.toISOString(), end: segEnd.toISOString(), minutes, after_event_id: prevId, before_event_id: before });
        segStart = null;
      }
    }
  };
  for (const ev of busy) {
    const s = new Date(ev.start_at!);
    if (s > cursor) push(cursor, s, ev.id);
    const e = new Date(ev.end_at!);
    if (e > cursor) {
      cursor = e;
      prevId = ev.id;
    }
  }
  if (end > cursor) push(cursor, end, null);
  return blocks;
}

export function itemMetrics(i: WorldItem, now: Date, tz: string) {
  const day = 86_400_000;
  return {
    days_until_due: i.due_at ? calendarDaysUntil(now, i.due_at, tz) : null,
    hours_until_due: i.due_at ? (new Date(i.due_at).getTime() - now.getTime()) / 3_600_000 : null,
    days_since_touched: (now.getTime() - new Date(i.touched_at).getTime()) / day,
    days_in_status: (now.getTime() - new Date(i.status_changed_at).getTime()) / day,
    days_overdue: i.due_at && new Date(i.due_at) < now ? (now.getTime() - new Date(i.due_at).getTime()) / day : 0,
  };
}

export function openItems(w: WorldState, types?: ItemType[]): WorldItem[] {
  return w.items.filter((i) => (!types || types.includes(i.type)) && !isClosed(i.type, i.status));
}

/** Resolve rule DSL fields against the world (and optionally one item). */
export function makeResolver(w: WorldState, item?: WorldItem) {
  const now = new Date(w.at);
  const local = toLocal(now, w.tz);
  const cur = currentEvent(w, now);
  const cls = inClassBlock(w, now);
  const fb = freeBlocks(w, now, 12);
  const freeNow = fb.find((b) => new Date(b.start).getTime() <= now.getTime() + 60_000);
  const nextEvent = eventsAround(w, now, new Date(now.getTime() + 24 * 3_600_000)).find((e) => new Date(e.start_at!) > now);
  const lastClassEnd = w.items
    .filter((e) => isClassEvent(e) && e.end_at && new Date(e.end_at) <= now)
    .map((e) => new Date(e.end_at!).getTime())
    .sort((a, b) => b - a)[0];

  const ctx: Record<string, unknown> = {
    "now.local_hour": local.hour + local.minute / 60,
    "now.local_minutes": local.hour * 60 + local.minute,
    "now.weekday": weekdayOf(now, w.tz),
    "now.is_weekend": local.weekday >= 6,
    "location.id": w.location_id,
    "calendar.in_event": !!cur,
    "calendar.in_class": !!cls,
    "calendar.next_event_minutes": nextEvent ? Math.round((new Date(nextEvent.start_at!).getTime() - now.getTime()) / 60_000) : null,
    "calendar.free_minutes_now": freeNow ? freeNow.minutes : 0,
    "calendar.minutes_since_class_ended": lastClassEnd ? Math.round((now.getTime() - lastClassEnd) / 60_000) : null,
    "activity.active_minutes_last_hour": w.activity.active_minutes_last_hour,
    "activity.current_category": w.activity.current_category,
    "counts.open_tasks": openItems(w, ["task"]).length,
    "counts.overdue_tasks": openItems(w, ["task"]).filter((t) => t.due_at && new Date(t.due_at) < now).length,
    "counts.messages_today": w.messages_today,
  };

  return (field: string): unknown => {
    if (field in ctx) return ctx[field];
    if (field.startsWith("ref.")) {
      const [, id, ...rest] = field.split(".");
      const target = w.items.find((i) => i.id === id);
      if (!target) return null;
      return itemField(target, rest.join("."), now, w.tz, freeNow?.minutes ?? 0);
    }
    if (field.startsWith("item.") && item) return itemField(item, field.slice(5), now, w.tz, freeNow?.minutes ?? 0);
    return null;
  };
}

function itemField(i: WorldItem, f: string, now: Date, tz: string, freeMinutes: number): unknown {
  const m = itemMetrics(i, now, tz);
  switch (f) {
    case "type":
      return i.type;
    case "status":
      return i.status;
    case "title":
      return i.title;
    case "tags":
      return i.tags;
    case "importance":
      return i.importance;
    case "kind":
      return i.kind;
    case "course":
      return i.course;
    case "project_id":
      return i.project_id;
    case "estimate_minutes":
      return i.estimate_minutes;
    case "days_until_due":
      return m.days_until_due;
    case "hours_until_due":
      return m.hours_until_due;
    case "days_since_touched":
      return m.days_since_touched;
    case "days_in_status":
      return m.days_in_status;
    case "days_overdue":
      return m.days_overdue;
    case "fits_free_block":
      return freeMinutes > 0 && (i.estimate_minutes ?? 45) <= freeMinutes;
    default:
      return null;
  }
}
