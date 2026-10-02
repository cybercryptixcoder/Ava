import { formatClock, inQuietHours, type MessageView } from "@ava/shared";
import type { Services } from "../core/services";
import type { Candidate } from "../rules/candidates";
import { inClassBlock, type WorldState } from "../rules/world";
import type { MessageDraft } from "../validator/message-validator";

export type DispatchOutcome =
  | { kind: "sent"; message: MessageView }
  | { kind: "queued"; message: MessageView; reason: string }
  | { kind: "deferred"; reason: string; until: string };

/**
 * Step 7 of the wake procedure: send now, or queue for the morning brief,
 * depending on urgency, caps, quiet hours and class blocks. The caps here
 * are constitutional; no rule or setting written by Ava can reach them.
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
  ): Promise<DispatchOutcome> {
    const { settings, clock, counters, messages, channels, log, scheduler } = this.svc;
    const s = settings.get();
    const now = clock.now();
    const tz = settings.tz();
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
      const message = messages.create({ ...base, status: "queued", block_reason: reason });
      log.info("message.queued", `Queued for the morning brief (${reason}): ${rendered.headline}`, { message_id: message.id, rule: c.rule_name }, wakeId);
      return { kind: "queued", message, reason };
    };

    if (inQuietHours(now, tz, s.quiet_hours.start, s.quiet_hours.end)) return queue("quiet hours");

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

    const message = messages.create({ ...base, status: "sent" });
    counters.add("messages.unprompted");
    log.info("message.sent", `Sent: ${rendered.headline} — because ${rendered.because}`, { message_id: message.id, rule: c.rule_name, cited: draft.cited_item_ids }, wakeId);
    await channels.deliver(message);
    this.svc.bus.emit({ type: "message.sent", message_id: message.id });
    return { kind: "sent", message };
  }
}
