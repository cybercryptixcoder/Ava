import type { MessageView, ResponseKind } from "@ava/shared";
import { RESPONSE_LABELS } from "@ava/shared";
import type { Services } from "../core/services";
import type { OptionResult } from "../actions/options";

/**
 * The four one-tap responses. Every response is logged; that log is how Ava
 * learns which rules help.
 *
 *   do it         run the chosen (or first) option; counts as acting on it
 *   not now       nothing changes; the rule's cooldown already holds it back
 *   already done  cited items are marked done at once and their wakes cancelled
 *   less of this  cooldown on the rule and its category; counts against the rule
 */
export class Responder {
  constructor(private svc: Services) {}

  async respond(messageId: string, response: ResponseKind, optionKey?: string | null): Promise<{ message: MessageView; result: OptionResult | null }> {
    const { messages, options, items, engine, rules, settings, log, bus } = this.svc;
    const m = messages.get(messageId);
    if (!m) throw new Error(`No message ${messageId}`);
    let result: OptionResult | null = null;
    let acted = false;
    switch (response) {
      case "do_it": {
        const opt = m.options.find((o) => o.key === optionKey) ?? m.options[0];
        if (opt) result = await options.run(opt.action, `message:${m.id}`);
        acted = true;
        break;
      }
      case "already_done":
        for (const c of m.cited) {
          const it = items.get(c.id);
          if (it && it.type !== "event") items.complete(it.id, `message:${m.id}:already_done`);
        }
        break;
      case "less_of_this": {
        if (m.rule_id) {
          const days = settings.get().rules.less_of_this_cooldown_days;
          engine.addCooldown(`rule:${m.rule_id}`, days * 24, "you asked for less of this");
          engine.addCooldown(`category:${rules.category(m.rule_id)}`, days * 24, "you asked for less of this");
        }
        break;
      }
      case "not_now":
        break;
    }
    const updated = messages.recordResponse(m.id, response, optionKey ?? null, acted);
    log.info(
      "message.response",
      `You answered "${RESPONSE_LABELS[response]}"${optionKey ? ` (${m.options.find((o) => o.key === optionKey)?.label ?? optionKey})` : ""} to: ${m.headline}`,
      { message_id: m.id, rule_id: m.rule_id, response, option: optionKey, result },
    );
    if (m.rule_id) rules.checkSelfPause(m.rule_id);
    bus.emit({ type: "state.changed", what: ["messages", "rules"] });
    return { message: updated, result };
  }
}
