import { DateTime } from "luxon";
import { formatClock, relativePhrase, statusLabel, type Item } from "@ava/shared";
import type { Services } from "../core/services";

/**
 * Compact text views of the life model for model prompts. Kept terse and
 * stable in order so they read well and cache well.
 */
export function itemLine(svc: Services, i: Item): string {
  const now = svc.clock.now();
  const tz = svc.settings.tz();
  const bits = [`${i.id}`, i.type, `"${i.title}"`, statusLabel(i.status).toLowerCase()];
  if (i.due_at) bits.push(`due ${relativePhrase(now, i.due_at, tz)}`);
  if (i.start_at && i.type === "event") bits.push(`${DateTime.fromISO(i.start_at).setZone(tz).toFormat("ccc d LLL HH:mm")}–${i.end_at ? DateTime.fromISO(i.end_at).setZone(tz).toFormat("HH:mm") : "?"}`);
  if (i.project_id) bits.push(`project ${i.project_id}`);
  if (i.importance) bits.push(`importance ${i.importance}`);
  if (i.tags.length) bits.push(`tags ${i.tags.join("/")}`);
  const d = i.data as Record<string, unknown>;
  for (const k of ["kind", "course", "estimate_minutes", "to_person", "next_step"]) if (d[k] !== undefined) bits.push(`${k.replace(/_/g, " ")} ${String(d[k])}`);
  const days = Math.floor((now.getTime() - new Date(i.status_changed_at).getTime()) / 86_400_000);
  if (days >= 2 && i.type !== "event") bits.push(`${days}d in status`);
  return `- ${bits.join(" | ")}`;
}

export function lifeModelText(svc: Services, opts: { calendarDays?: number; includeBeliefs?: boolean } = {}): string {
  const { items, clock, settings, beliefs, questions } = svc;
  const now = clock.now();
  const tz = settings.tz();
  const local = DateTime.fromJSDate(now).setZone(tz);
  const cal = items.list({
    types: ["event"],
    starts_between: [now.toISOString(), local.plus({ days: opts.calendarDays ?? 2 }).endOf("day").toUTC().toISO()!],
  });
  const open = items.list({ open: true }).filter((i) => i.type !== "event" && i.type !== "rhythm");
  const by = (t: string) => open.filter((i) => i.type === t);
  const sections: string[] = [];
  sections.push(`Now: ${local.toFormat("cccc d LLL yyyy, HH:mm")} in ${settings.location().label} (${tz}). Quiet hours ${settings.get().quiet_hours.start}–${settings.get().quiet_hours.end}.`);
  sections.push(`Calendar (next ${opts.calendarDays ?? 2} days):\n${cal.map((i) => itemLine(svc, i)).join("\n") || "- nothing"}`);
  const deadlines = open.filter((i) => i.due_at).sort((a, b) => a.due_at!.localeCompare(b.due_at!));
  sections.push(`Open items with deadlines:\n${deadlines.map((i) => itemLine(svc, i)).join("\n") || "- none"}`);
  sections.push(`Other open tasks:\n${by("task").filter((i) => !i.due_at).map((i) => itemLine(svc, i)).join("\n") || "- none"}`);
  sections.push(`Projects:\n${items.list({ types: ["project"] }).filter((p) => p.status !== "dropped").map((i) => itemLine(svc, i) + ` | last touched ${Math.floor((now.getTime() - new Date(i.touched_at).getTime()) / 86_400_000)}d ago`).join("\n") || "- none"}`);
  sections.push(`Commitments and open loops:\n${[...by("commitment"), ...by("open_loop")].map((i) => itemLine(svc, i)).join("\n") || "- none"}`);
  sections.push(`Goals:\n${by("goal").map((i) => itemLine(svc, i)).join("\n") || "- none"}`);
  const threadLine = (t: { id: string; title: string }, indent: string) => `${indent}- ${t.title} (${t.id}): ${items.list({ thread_id: t.id, open: true }).map((i) => i.id).join(", ") || "nothing open"}`;
  const top = svc.threads.activeTopLevel();
  const kids = (id: string) => svc.threads.list().filter((t) => t.parent_id === id);
  sections.push(`Threads (top level, then grouped under it; item ids):\n${top.map((t) => [threadLine(t, ""), ...kids(t.id).map((k) => threadLine(k, "  "))].join("\n")).join("\n") || "- none"}`);
  if (opts.includeBeliefs !== false) {
    const bs = beliefs.list({ status: ["active", "proposed"] });
    sections.push(
      `Beliefs (what Ava thinks; provenance, effective confidence):\n${bs.map((b) => `- ${b.id} [${b.area}] ${b.statement} (${b.provenance}${b.status === "proposed" ? ", unconfirmed" : ""}, ${b.effective_confidence})`).join("\n") || "- none"}`,
    );
    const q = questions.open();
    if (q) sections.push(`Open question to Shreyas: ${q.text}`);
  }
  return sections.join("\n\n");
}

export function recentActivityText(svc: Services, days: number): string {
  const { db, clock, settings, messages, rules } = svc;
  const tz = settings.tz();
  const since = new Date(clock.now().getTime() - days * 86_400_000).toISOString();
  const done = db.all<{ at: string; item_id: string; new_value: string }>(
    "SELECT h.at, h.item_id, h.new_value FROM item_history h WHERE h.field = 'status' AND h.at >= ? ORDER BY h.at",
    [since],
  );
  const titles = new Map(svc.items.byIds(Array.from(new Set(done.map((d) => d.item_id)))).map((i) => [i.id, i.title]));
  const msgs = messages.list({ since, limit: 60 });
  const lines: string[] = [];
  lines.push(
    `Status changes in the last ${days} days:\n${done.map((d) => `- ${DateTime.fromISO(d.at).setZone(tz).toFormat("ccc HH:mm")} ${titles.get(d.item_id) ?? d.item_id} -> ${d.new_value}`).join("\n") || "- none"}`,
  );
  lines.push(
    `Messages Ava sent and his responses:\n${msgs
      .filter((m) => m.kind === "nudge")
      .map((m) => `- ${DateTime.fromISO(m.created_at).setZone(tz).toFormat("ccc HH:mm")} [${m.rule_name ?? "?"}] "${m.headline}" -> ${m.response ?? (m.acted ? "acted" : m.status === "queued" ? "queued for brief" : "no response")}`)
      .join("\n") || "- none"}`,
  );
  const rv = rules.list();
  lines.push(
    `Rules and their stats (fired / messages / acted / precision):\n${[...rv.builtin, ...rv.dynamic]
      .map((r) => `- ${r.id} "${r.name}" [${r.status}${r.enabled ? "" : ", off"}] ${r.stats.fired}/${r.stats.messages}/${r.stats.acted}/${r.stats.precision ?? "n/a"}${r.definition ? ` :: ${r.readable}` : ""}`)
      .join("\n")}`,
  );
  if (rv.proposed.length) lines.push(`Rule proposals awaiting approval:\n${rv.proposed.map((r) => `- ${r.id} "${r.name}": ${r.readable}`).join("\n")}`);
  const reports = svc.executors.recentReports(since);
  if (reports.length) lines.push(`Executor reports (plan-fit feedback):\n${reports.map((r) => `- ${r.title} [${r.status}]${r.plan_fit ? ` fits=${r.plan_fit.fits}: ${r.plan_fit.note}` : ""}`).join("\n")}`);
  const turns = db.all<{ created_at: string; text_enc: string }>("SELECT created_at, text_enc FROM turns WHERE role = 'user' AND created_at >= ? ORDER BY created_at DESC LIMIT 12", [since]);
  if (turns.length) {
    lines.push(
      `What he said recently (newest first, trimmed):\n${turns.map((t) => `- ${DateTime.fromISO(t.created_at).setZone(tz).toFormat("ccc HH:mm")}: ${(svc.cipher.decOpt(t.text_enc) ?? "").slice(0, 400)}`).join("\n")}`,
    );
  }
  const rh = svc.items.list({ types: ["rhythm"] });
  if (rh.length) lines.push(`Rhythms (from data):\n${rh.map((r) => `- ${r.title}: ${String(r.data.summary ?? "")}`).join("\n")}`);
  const wakes = svc.scheduler.pending({ to: new Date(clock.now().getTime() + 2 * 86_400_000) });
  lines.push(`Ava's pending wakes:\n${wakes.map((w) => `- ${formatClock(w.due_at, tz)} ${DateTime.fromISO(w.due_at).setZone(tz).toFormat("ccc")} ${w.kind}: ${w.reason}`).join("\n") || "- none"}`);
  return lines.join("\n\n");
}

export const DSL_GUIDE = `Dynamic rule definition (JSON). Evaluated deterministically by the system, never by a model.
{
  "when": <condition over context fields>,                 // optional
  "for_each": { "type": "task" | ["task","commitment"], "where": <condition over item fields> },  // optional
  "limit": 1-5,                                            // items cited per firing
  "action": { "kind": "suggest", "intent": "...", "options": ["..."] }      // a message (needs his approval)
          | { "kind": "prepare", "executor": "practice_set|summary|draft|outline|plan", "instructions": "..." }  // silent prep
          | { "kind": "wake", "reason": "...", "in_minutes": 30 } or { "kind": "wake", "reason": "...", "at_local": "19:30" },
  "cooldown_hours": number,
  "category": "short-slug"
}
Conditions: {"all":[...]}, {"any":[...]}, {"not":{...}}, or {"field": "...", "op": "...", "value": ...}
Ops: eq ne lt lte gt gte in not_in contains not_contains between exists not_exists
Context fields: now.local_hour (e.g. 19.5), now.local_minutes, now.weekday ("mon".."sun"), now.is_weekend, location.id,
  calendar.in_event, calendar.in_class, calendar.next_event_minutes, calendar.free_minutes_now, calendar.minutes_since_class_ended,
  activity.active_minutes_last_hour, activity.current_category, counts.open_tasks, counts.overdue_tasks, counts.messages_today
Item fields: item.type, item.status, item.title, item.tags, item.importance, item.kind, item.course, item.project_id,
  item.estimate_minutes, item.days_until_due, item.hours_until_due, item.days_since_touched, item.days_in_status, item.days_overdue, item.fits_free_block
Specific items: ref.<item_id>.<field>
Rules can never: raise caps, change quiet hours, take external actions (send, submit, pay), approve themselves, or exceed the wake budget.`;
