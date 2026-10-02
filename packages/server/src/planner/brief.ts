import { DateTime } from "luxon";
import { formatClock, type BriefView, type CardView, type HydratedModule, type ModuleSpec, type WakeView } from "@ava/shared";
import type { Services } from "../core/services";
import { j, js, newId } from "../db/db";

/**
 * The morning stack. There is no written brief any more: at brief time the
 * cards that waited overnight join the stack, along with the occasional
 * question, rule approval and inference. The optional spoken version is a
 * few sentences that point at the cards; it never recites the day. Nothing
 * is pushed: it waits until he opens Ava.
 */
export class BriefComposer {
  constructor(private svc: Services) {}

  async compose(wakeId: string): Promise<string> {
    const svc = this.svc;
    const { clock, settings, messages, questions, db, log, items, cards, scheduler } = svc;
    const tz = settings.tz();
    const now = clock.now();
    const date = DateTime.fromJSDate(now).setZone(tz).toISODate()!;
    if (db.get("SELECT id FROM briefs WHERE date = ?", [date])) return "morning stack already composed today";

    // Overnight messages: drop stale ones (older than a day and a half, or about items now closed) and duplicates.
    const seenKeys = new Set<string>();
    const queued = messages.queuedForBrief().filter((m) => {
      const stale = now.getTime() - new Date(m.created_at).getTime() > 36 * 3_600_000;
      const closed = m.cited.length > 0 && m.cited.every((c) => {
        const it = items.get(c.id);
        return !it || ["done", "dropped", "closed", "cancelled"].includes(it.status);
      });
      const key = `${m.rule_id}:${m.cited.map((c) => c.id).join(",")}`;
      const dup = seenKeys.has(key);
      seenKeys.add(key);
      if (stale || closed || dup) {
        db.run("UPDATE messages SET status = 'dropped', block_reason = ? WHERE id = ?", [stale ? "stale by morning" : closed ? "items already done" : "duplicate", m.id]);
        cards.closeRef("message", m.id, "expired");
        return false;
      }
      return true;
    });
    messages.markInBrief(queued.map((m) => m.id));

    const question = questions.open();
    if (question) {
      cards.forQuestion(question);
      questions.markAsked(question.id);
    }
    cards.refreshPeriodic();

    const stack = cards.stack();
    const next = scheduler.pending({ from: now }).find((w) => w.kind !== "event" && w.kind !== "executor");
    const spoken = morningWords(stack.cards, next ? scheduler.view(next) : null, tz);

    const id = newId("brf");
    db.run("INSERT INTO briefs (id, date, spoken, modules, question_id, message_ids, drafted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      id,
      date,
      spoken,
      js([]),
      question?.id ?? null,
      js(queued.map((m) => m.id)),
      "system",
      now.toISOString(),
    ]);
    // Pre-render the spoken version so it plays the moment he opens Ava, if he wants it.
    if (svc.voice.ttsAvailable("async")) {
      void svc.voice
        .renderAsync(spoken, { purpose: "brief", operational: true })
        .then((audio) => audio && db.run("UPDATE briefs SET audio_id = ? WHERE id = ?", [audio.audio_id, id]))
        .catch((e) => log.warn("brief.tts_failed", `Couldn't pre-render the morning words: ${(e as Error).message}`));
    }
    svc.bus.emit({ type: "brief.ready", brief_id: id });
    log.info("brief.composed", `Morning stack: ${stack.cards.length} card${stack.cards.length === 1 ? "" : "s"}${queued.length ? `, ${queued.length} waited overnight` : ""}`, { brief_id: id, cards: stack.cards.map((c) => c.title) }, wakeId);
    return `morning stack: ${stack.cards.length} cards (${queued.length} waited overnight)`;
  }

  view(id?: string): BriefView | null {
    const { db, canvas, messages, questions, rules, settings, clock } = this.svc;
    const r = id
      ? db.get<Record<string, unknown>>("SELECT * FROM briefs WHERE id = ?", [id])
      : db.get<Record<string, unknown>>("SELECT * FROM briefs WHERE date = ?", [DateTime.fromJSDate(clock.now()).setZone(settings.tz()).toISODate()]);
    if (!r) return null;
    const modules = j<ModuleSpec[]>(r.modules, [])
      .map((s) => canvas.hydrator.hydrate(s))
      .filter((x): x is { ok: true; module: HydratedModule } => x.ok)
      .map((x) => x.module);
    return {
      id: String(r.id),
      date: String(r.date),
      spoken: String(r.spoken),
      modules,
      question: r.question_id ? questions.get(String(r.question_id)) : null,
      messages: j<string[]>(r.message_ids, []).map((m) => messages.get(m)!).filter(Boolean),
      rule_proposals: rules.list().proposed,
      created_at: String(r.created_at),
      audio_id: (r.audio_id as string) ?? null,
      drafted_by: r.drafted_by as BriefView["drafted_by"],
    };
  }
}

/** A few sentences that point at the cards. */
export function morningWords(cards: CardView[], next: WakeView | null, tz: string): string {
  if (!cards.length) return `Morning. Nothing needs you right now.${next ? ` I'll check in at ${formatClock(next.due_at, tz)}.` : ""}`;
  if (cards.length === 1) return `Morning. One thing needs you: ${cards[0].title}.`;
  const n = ["", "", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"][cards.length] ?? String(cards.length);
  return `Morning. ${n} things in your stack. First: ${cards[0].title}.`;
}
