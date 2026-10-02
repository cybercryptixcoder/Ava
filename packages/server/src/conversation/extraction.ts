import { z } from "zod";
import { DateTime } from "luxon";
import { ITEM_TYPES, type Change, type ItemType } from "@ava/shared";
import type { Services } from "../core/services";
import { itemLine } from "../planner/context";

const ExtractedSchema = z.object({
  changes: z.array(
    z.object({
      op: z.enum(["create_item", "update_item", "set_status", "complete_item", "reschedule", "add_belief"]),
      summary: z.string(),
      quote: z.string(),
      item_id: z.string().nullable(),
      item_type: z.enum(["task", "project", "commitment", "open_loop", "goal", "preference"]).nullable(),
      title: z.string().nullable(),
      status: z.string().nullable(),
      due_local: z.string().nullable(),
      start_local: z.string().nullable(),
      end_local: z.string().nullable(),
      project_title: z.string().nullable(),
      importance: z.number().int().nullable(),
      tags: z.array(z.string()),
      kind: z.string().nullable(),
      course: z.string().nullable(),
      estimate_minutes: z.number().int().nullable(),
      to_person: z.string().nullable(),
      next_step: z.string().nullable(),
      notes: z.string().nullable(),
      belief_area: z.string().nullable(),
      belief_statement: z.string().nullable(),
      belief_provenance: z.enum(["stated", "inferred"]).nullable(),
      belief_confidence: z.number().nullable(),
    }),
  ),
});
export type Extracted = z.infer<typeof ExtractedSchema>;

export const EXTRACTION_SYSTEM = `You turn what Shreyas says (often long, rambling, dictated) into structured changes to his life model. Each change becomes a confirmation chip he accepts, edits or rejects, so propose what he actually said or clearly implied, and nothing else.

What to extract:
- New tasks, deadlines (quiz, exam, assignment, deadline), projects, commitments he made to someone ("I told Riya I'd send the slides by Friday"), replies he owes, goals, preferences.
- Updates to existing items: "I finished the homework" -> complete_item on that item; "push quiz prep to tomorrow" -> reschedule; "I've drafted the essay" -> set_status drafted; "almost done with X" -> almost_done; "started Y" -> started.
- Beliefs: durable facts about him or his world ("I study best late at night", "the robotics club doesn't matter to me anymore"). provenance "stated" when he said it outright, "inferred" when you're reading between the lines (keep those rare and confidence modest). Never infer feelings or states of mind.

Rules:
- Match existing items by meaning and use their exact id. Only create a new item when nothing existing fits.
- Times: write local times as "YYYY-MM-DDTHH:MM" in his time zone. Resolve "tomorrow", "Friday", "next week" against the current date. If he gives a day without a time, use 23:59 for deadlines. If no date at all, leave it null.
- status values: tasks use todo, started, drafted, almost_done, done, dropped. Projects: active, paused, done, dropped.
- summary: the chip text, short and specific ("New quiz: CMPSC 465 Quiz 4, Thu 9:00"). quote: the words this came from.
- If he's just thinking out loud with nothing to record, return no changes. Ideas he's exploring aren't tasks unless he commits to them.`;

/** Convert the model's flat records into validated Change objects. */
export function toChanges(svc: Services, out: Extracted): { change: Change; summary: string; reason: string }[] {
  const tz = svc.settings.tz();
  const local = (s: string | null) => (s ? DateTime.fromISO(s, { zone: tz }).toUTC().toISO() : null);
  const res: { change: Change; summary: string; reason: string }[] = [];
  for (const c of out.changes) {
    const exists = (id: string | null) => !!id && !!svc.items.get(id);
    try {
      switch (c.op) {
        case "create_item": {
          if (!c.item_type || !c.title) continue;
          const def = ITEM_TYPES[c.item_type as ItemType];
          const data: Record<string, unknown> = {};
          if (c.kind) data.kind = c.kind;
          if (c.course) data.course = c.course;
          if (c.estimate_minutes) data.estimate_minutes = c.estimate_minutes;
          if (c.to_person) data.to_person = c.to_person;
          if (c.next_step) data.next_step = c.next_step;
          if (c.notes) data.notes = c.notes;
          if (c.item_type === "project" && (c.importance ?? 0) >= 2) data.important = true;
          if (c.item_type === "open_loop" && !data.kind) data.kind = c.to_person ? "reply_owed" : "started";
          res.push({
            change: {
              op: "create_item",
              item: {
                type: c.item_type,
                title: c.title,
                status: c.status && def.statuses.includes(c.status) ? c.status : undefined,
                due_at: local(c.due_local),
                start_at: local(c.start_local),
                end_at: local(c.end_local),
                importance: c.importance === null ? undefined : Math.max(0, Math.min(3, c.importance)),
                tags: c.tags,
                data,
              },
              project_title: c.project_title ?? undefined,
            },
            summary: c.summary,
            reason: c.quote,
          });
          break;
        }
        case "complete_item":
          if (exists(c.item_id)) res.push({ change: { op: "complete_item", item_id: c.item_id! }, summary: c.summary, reason: c.quote });
          break;
        case "set_status":
          if (exists(c.item_id) && c.status) res.push({ change: { op: "set_status", item_id: c.item_id!, status: c.status }, summary: c.summary, reason: c.quote });
          break;
        case "reschedule":
          if (exists(c.item_id))
            res.push({
              change: { op: "reschedule", item_id: c.item_id!, due_at: c.due_local ? local(c.due_local) : undefined, start_at: c.start_local ? local(c.start_local) : undefined, end_at: c.end_local ? local(c.end_local) : undefined },
              summary: c.summary,
              reason: c.quote,
            });
          break;
        case "update_item": {
          if (!exists(c.item_id)) break;
          const data: Record<string, unknown> = {};
          if (c.next_step) data.next_step = c.next_step;
          if (c.notes) data.notes = c.notes;
          if (c.estimate_minutes) data.estimate_minutes = c.estimate_minutes;
          res.push({
            change: {
              op: "update_item",
              item_id: c.item_id!,
              patch: { ...(c.title ? { title: c.title } : {}), ...(c.importance !== null ? { importance: Math.max(0, Math.min(3, c.importance)) } : {}), ...(Object.keys(data).length ? { data } : {}), ...(c.tags.length ? { tags: c.tags } : {}) },
            },
            summary: c.summary,
            reason: c.quote,
          });
          break;
        }
        case "add_belief":
          if (c.belief_statement)
            res.push({
              change: {
                op: "add_belief",
                belief: {
                  area: c.belief_area ?? "preferences",
                  statement: c.belief_statement,
                  provenance: c.belief_provenance ?? "stated",
                  confidence: Math.max(0.1, Math.min(1, c.belief_confidence ?? (c.belief_provenance === "inferred" ? 0.6 : 0.9))),
                },
              },
              summary: c.summary,
              reason: c.quote,
            });
          break;
      }
    } catch (e) {
      svc.log.warn("extraction.skip", `Skipped an extracted change: ${(e as Error).message}`, { change: c });
    }
  }
  return res;
}

export function extractionContext(svc: Services): string {
  const { items, clock, settings } = svc;
  const local = DateTime.fromJSDate(clock.now()).setZone(settings.tz());
  const open = items.list({ open: true }).filter((i) => !["event", "rhythm", "saved_item"].includes(i.type));
  const projects = items.list({ types: ["project"] });
  return `Now: ${local.toFormat("cccc yyyy-MM-dd HH:mm")} (${settings.tz()}).
Existing open items:
${open.map((i) => itemLine(svc, i)).join("\n") || "- none"}
Projects (any status):
${projects.map((p) => `- ${p.id} "${p.title}" [${p.status}]`).join("\n") || "- none"}`;
}

/** Run extraction over a piece of text. Returns validated changes (not yet proposed). */
export async function extract(
  svc: Services,
  text: string,
  opts: { purpose: string; origin: "system" | "interactive"; extraInstruction?: string; signal?: AbortSignal },
): Promise<{ change: Change; summary: string; reason: string }[]> {
  const res = await svc.models.complete({
    purpose: opts.purpose,
    origin: opts.origin,
    model: svc.cfg.models.fast,
    maxTokens: 6000,
    schema: ExtractedSchema,
    signal: opts.signal,
    system: [{ text: EXTRACTION_SYSTEM, cache: true }],
    messages: [{ role: "user", content: `${extractionContext(svc)}\n${opts.extraInstruction ? `\n${opts.extraInstruction}\n` : ""}\nWhat he said:\n"""\n${text}\n"""` }],
  });
  if (!res.parsed) throw new Error(res.parseError ?? "extraction failed");
  return toChanges(svc, res.parsed);
}
