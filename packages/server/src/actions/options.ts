import { ChangeSchema, type OptionAction } from "@ava/shared";
import type { Services } from "../core/services";

export interface OptionResult {
  kind: OptionAction["kind"];
  summary: string;
  exec_task_id?: string;
  reply_text?: string;
  open?: string;
}

/**
 * Runs an option Shreyas tapped (on a message, a canvas options card, or a
 * brief). Tapping is explicit confirmation, so state changes apply at once.
 * Nothing here can act outside Ava: executors only produce artifacts.
 */
export class OptionRunner {
  constructor(private svc: Services) {}

  async run(action: OptionAction, origin: string): Promise<OptionResult> {
    const { executors, proposals, items, clock, log } = this.svc;
    switch (action.kind) {
      case "start_executor": {
        const task = executors.start({ kind: action.executor, item_id: action.item_id ?? null, instructions: action.instructions, origin, silent: false });
        if (!task) return { kind: action.kind, summary: "Couldn't start the work (model unavailable or over budget)" };
        return { kind: action.kind, summary: `Started: ${task.title}`, exec_task_id: task.id };
      }
      case "propose_change": {
        const change = ChangeSchema.parse(action.change);
        proposals.apply(change, `tap:${origin}`);
        log.info("option.applied", `Applied from a tap: ${action.summary}`, { change, origin });
        return { kind: action.kind, summary: action.summary };
      }
      case "snooze_item": {
        const until = new Date(clock.now().getTime() + action.hours * 3_600_000).toISOString();
        const it = items.update(action.item_id, { data: { snoozed_until: until } }, `snooze:${origin}`, { touch: false });
        log.info("option.snoozed", `Snoozed ${it.title} for ${action.hours} h`, { item_id: it.id, until });
        return { kind: action.kind, summary: `Snoozed ${it.title}` };
      }
      case "reply":
        return { kind: action.kind, summary: action.text, reply_text: action.text };
      case "open":
        return { kind: action.kind, summary: `Open ${action.screen}`, open: action.screen };
      case "none":
        return { kind: action.kind, summary: "Noted" };
    }
  }
}
