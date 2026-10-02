import { DateTime } from "luxon";
import { atLocal, formatClock, inQuietHours, type MessageView } from "@ava/shared";
import type { Services } from "../core/services";
import type { Candidate } from "../rules/candidates";
import { inClassBlock, type WorldState } from "../rules/world";
import type { MessageDraft } from "../validator/message-validator";

export type DispatchOutcome =
  | { kind: "sent"; message: MessageView }
  | { kind: "queued"; message: MessageView; reason: string }
  | { kind: "deferred"; reason: string; until: string }
  | { kind: "held"; reason: string }
  | { kind: "dropped"; reason: string };

/**
 * Step 7 of the wake procedure: send now, or queue for the morning stack,
 * depending on urgency, caps, quiet hours and class blocks. The caps here
 * are constitutional; no rule or setting written by Ava can reach them.
 *
 * Beyond the hard rules: at most one message goes out per wake (so nudges
 * never arrive in a burst), anything due before the morning brief waits for
 * the brief, and time-bound suggestions that can't go out now are dropped
 * rather than queued into tomorrow.
 */
export class Dispatcher {
  constructor(private svc: Services) {}

  async dispatch(
    c: Candidate,
    draft: MessageDraft,
    rendered: { headline: string; because: string },
    world: WorldState,
    wakeId: string,
    draftedBy: "model" | "fallback_template",
    sentThisWake: number,
  ): Promise<DispatchOutcome> {
    const { settings, clock, counters, messages, cards, log, scheduler, db } = this.svc;
    const s = settings.get();
    const now = clock.now();
    const tz = settings.tz();
    const queueable = c.queueable !== false;
    const base = {
      kind: "nudge" as const,
      rule_id: c.rule_id,
      wake_id: wakeId,
      headline: rendered.headline,
      because_template: draft.because,
      because: rendered.because,
      cited: draft.cited_item_ids,
      options: draft.options,
      urgency: draft.urgency,
      dedupe_key: c.dedupe_key,
      drafted_by: draftedBy,
    };
    const queue = (reason: string): DispatchOutcome => {
      if (!queueable) {
        log.info("message.dropped", `Dropped a time-bound suggestion (${reason}): ${rendered.headline}`, { rule: c.rule_name }, wakeId);
        return { kind: "dropped", reason };
      }
      const message = messages.create({ ...base, status: "queued", block_reason: reason });
      // Queued means it waits for the morning stack, silently.
      cards.fromMessage(message, { visibleFrom: cards.nextMorning(), priority: c.priority });
      log.info("message.queued", `Queued for the morning stack (${reason}): ${rendered.headline}`, { message_id: message.id, rule: c.rule_name }, wakeId);
      return { kind: "queued", message, reason };
    };

    if (inQuietHours(now, tz, s.quiet_hours.start, s.quiet_hours.end)) return queue("quiet hours");

    // Before today's brief has gone out, things wait for the brief instead of arriving one by one.
    const today = DateTime.fromJSDate(now).setZone(tz).toISODate()!;
    const briefAt = atLocal(today, s.brief_time, tz);
    const briefDone = !!db.get("SELECT id FROM briefs WHERE date = ?", [today]);
    if (!briefDone && now < briefAt) return queue(`the morning brief is at ${formatClock(briefAt, tz)}`);

    const cls = inClassBlock(world, now);
    if (cls) {
      if (draft.urgency === "now" && cls.end_at) {
        const at = new Date(new Date(cls.end_at).getTime() + 5 * 60_000);
        scheduler.system({
          kind: "lookahead",
          at,
          reason: `After ${cls.title}: deliver what waited for class to end`,
          owner: "system",
          item_ids: c.item_ids,
          dedupe_key: `after-class:${cls.id}`,
        });
        log.info("message.deferred", `Held "${rendered.headline}" until ${cls.title} ends at ${formatClock(cls.end_at, tz)}`, { rule: c.rule_name }, wakeId);
        return { kind: "deferred", reason: `in ${cls.title}`, until: at.toISOString() };
      }
      return queue(`during ${cls.title}`);
    }

    if (draft.urgency === "brief") return queue("not time-sensitive");

    const sent = counters.get("messages.unprompted");
    if (sent >= s.caps.unprompted_per_day) return queue(`daily cap of ${s.caps.unprompted_per_day} reached`);

    if (sentThisWake >= s.caps.max_per_wake) {
      log.info("message.held", `Held "${rendered.headline}" for a later wake (one message per wake)`, { rule: c.rule_name }, wakeId);
      return { kind: "held", reason: "one message per wake" };
    }

    const message = messages.create({ ...base, status: "sent" });
    counters.add("messages.unprompted");
    log.info("message.sent", `Sent: ${rendered.headline} — because ${rendered.because}`, { message_id: message.id, rule: c.rule_name, cited: draft.cited_item_ids }, wakeId);
    // Sent means it joins the stack now; only time-sensitive cards are pushed, and only a couple a day.
    const card = cards.fromMessage(message, { visibleFrom: now, priority: c.priority, expiresAt: queueable ? null : new Date(now.getTime() + c.cooldown_hours * 3_600_000) });
    await cards.pushIfDue(card, wakeId);
    this.svc.bus.emit({ type: "message.sent", message_id: message.id });
    return { kind: "sent", message };
  }
}
