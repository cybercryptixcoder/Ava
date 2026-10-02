import type { Services } from "../core/services";

export type EventKind = "class" | "exam" | "meeting" | "social" | "other";

const COURSE_CODE = /\b[A-Z]{2,6}\s?-?\d{3}[A-Z]?\b/;

/** Classify a calendar event so the constitution can keep quiet during class and exams. */
export function classifyEvent(title: string, description = "", calendarName = "", feedKind?: string): EventKind {
  const t = `${title} ${description.slice(0, 200)}`;
  if (/\b(exam|midterm|mid-term|final exam|finals|quiz|test)\b/i.test(t)) return "exam";
  if (/\b(lecture|class|lab|recitation|seminar|tutorial|discussion section|studio)\b/i.test(t)) return "class";
  if (feedKind === "course" || /course|class|schedule|timetable/i.test(calendarName)) return COURSE_CODE.test(title) || feedKind === "course" ? "class" : "other";
  if (COURSE_CODE.test(title) && !/\b(due|assignment|homework|hw|project)\b/i.test(t)) return "class";
  if (/\b(meeting|1:1|one-on-one|sync|standup|stand-up|call|interview|office hours)\b/i.test(t)) return "meeting";
  if (/\b(dinner|lunch|party|birthday|drinks|hangout|movie|game)\b/i.test(t)) return "social";
  return "other";
}

/** Course feeds often list deadlines as zero-length events. */
export function deadlineKind(title: string, description = ""): string | null {
  const t = `${title} ${description.slice(0, 200)}`;
  if (/\b(quiz)\b/i.test(t)) return "quiz";
  if (/\b(exam|midterm|final)\b/i.test(t)) return "exam";
  if (/\b(homework|hw\s?\d|problem set|pset|assignment|lab report|essay|paper|project)\b/i.test(t) || /\bdue\b/i.test(t)) return "assignment";
  return null;
}

export function courseOf(title: string): string | null {
  return COURSE_CODE.exec(title)?.[0]?.replace(/\s?-?(\d)/, " $1") ?? null;
}

/** Mark items from a source whose ref wasn't seen in the latest full window as cancelled/removed. */
export function removeMissing(svc: Services, source: string, seen: Set<string>, windowStart: string, windowEnd: string): number {
  const rows = svc.db.all<{ id: string; source_ref: string; type: string }>(
    "SELECT id, source_ref, type FROM items WHERE source = ? AND deleted_at IS NULL AND COALESCE(start_at, due_at) >= ? AND COALESCE(start_at, due_at) <= ?",
    [source, windowStart, windowEnd],
  );
  let n = 0;
  for (const r of rows) {
    if (seen.has(r.source_ref)) continue;
    if (r.type === "event") svc.items.update(r.id, { status: "cancelled" }, source, { touch: false });
    else svc.items.remove(r.id, source);
    n++;
  }
  return n;
}
