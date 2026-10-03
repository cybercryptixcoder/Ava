import { localDateKey } from "@ava/shared";
import { DateTime } from "luxon";
import type { Services } from "../core/services";
import type { Wake } from "../scheduler/scheduler";
import { validateMessage } from "../validator/message-validator";
import { Dispatcher } from "./dispatcher";
import { Drafter } from "./drafter";

/**
 * The wake procedure. Every wake follows the same steps:
 *
 *   1. Pull changes since the last wake.
 *   2. Update state.
 *   3. Evaluate all active rules deterministically to produce candidates.
 *   4. No candidates: request the next wakes, log, and stop without a model call.
 *   5. Candidates: one bounded model call to rank and draft (or templates).
 *   6. Run the validator.
 *   7. Send now, or queue for the morning brief.
 *   8. Schedule the next wakes and log.
 *
 * Briefs, planning sessions, the weekly review and executor sessions are
 * wakes too; they do their own bounded work after steps 1–2.
 */
export class WakeProcedure {
  private drafter: Drafter;
  private dispatcher: Dispatcher;

  constructor(private svc: Services) {
    this.drafter = new Drafter(svc);
    this.dispatcher = new Dispatcher(svc);
  }

  async run(w: Wake): Promise<string> {
    const { log } = this.svc;
    log.info("wake.start", `${w.kind} wake: ${w.reason}`, { kind: w.kind, owner: w.owner, items: w.item_ids }, w.id);
    let outcome: string;
    switch (w.kind) {
      case "heartbeat":
        outcome = await this.heartbeat(w);
        break;
      case "brief":
        await this.pull(w, false);
        outcome = await this.svc.brief.compose(w.id);
        break;
      case "evening":
        await this.pull(w, false);
        outcome = await this.svc.planner.evening(w.id);
        break;
      case "weekly":
        await this.pull(w, false);
        outcome = await this.svc.planner.weekly(w.id);
        break;
      case "planning_new":
        outcome = await this.svc.planner.newContext(w.id, String(w.payload.about ?? w.reason));
        break;
      case "executor":
        outcome = await this.svc.executors.runSession(String(w.payload.exec_task_id), w.id);
        break;
      case "consolidation":
        outcome = await this.svc.consolidation.run(w.id);
        break;
      default:
        outcome = await this.standard(w);
    }
    log.info("wake.end", `${w.kind} wake finished: ${outcome}`, undefined, w.id);
    await this.pingDeadman();
    return outcome;
  }

  /** Step 1: pull changes. Heartbeats poll every source that can't push; other wakes use current state. */
  private async pull(w: Wake, poll: boolean): Promise<void> {
    if (poll) await this.svc.sources.pollDue(w.id);
  }

  /** Step 2: update state that depends on time passing. */
  private updateState(w: Wake) {
    const { engine, rules, rhythms, clock, settings, counters } = this.svc;
    const world = engine.world();
    const expired = rules.expireDue(world);
    // Rhythms are recomputed at most once a day.
    const today = localDateKey(clock.now(), settings.tz());
    if (counters.get("rhythms.computed", today) === 0) {
      rhythms.recompute();
      counters.add("rhythms.computed", 1, today);
    }
    return { world: expired.length ? engine.world() : world };
  }

  private async heartbeat(w: Wake): Promise<string> {
    await this.pull(w, true);
    const result = await this.standard(w);
    const { scheduler, engine, settings } = this.svc;
    const created = scheduler.lookahead(engine.world(), settings.get().heartbeat_every_hours + 1);
    if (created.length) this.svc.log.info("schedule.lookahead", `Heartbeat requested ${created.length} precise wake${created.length === 1 ? "" : "s"}: ${created.map((c) => c.reason).join("; ")}`, undefined, w.id);
    return `${result}; ${created.length} lookahead wakes`;
  }

  /** Steps 2–8. */
  async standard(w: Wake): Promise<string> {
    const svc = this.svc;
    const { engine, scheduler, log, settings, executors, messages, counters, rules, items, clock } = svc;
    const { world } = this.updateState(w);
    const evaluation = engine.evaluate(world, w.id);

    // Internal actions are deterministic: preparation and wake requests need no model call.
    const suggest = evaluation.candidates.filter((c) => c.action.kind === "suggest");
    for (const c of evaluation.candidates.filter((x) => x.action.kind !== "suggest")) {
      if (c.action.kind === "prepare") {
        const task = executors.start(
          { kind: c.action.executor, item_id: c.item_ids[0] ?? null, instructions: c.action.instructions, origin: `rule:${c.rule_id}`, silent: true },
          w.id,
        );
        engine.recordFiring(c, w.id, task ? "prepared" : "prepare_failed", null, { exec_task_id: task?.id });
      } else if (c.action.kind === "wake") {
        const now = clock.now();
        const at = c.action.in_minutes
          ? new Date(now.getTime() + c.action.in_minutes * 60_000)
          : c.action.at_local
            ? nextLocalTime(now, c.action.at_local, settings.tz())
            : new Date(now.getTime() + 60 * 60_000);
        const r = scheduler.request({ kind: "rule", at, reason: c.action.reason, owner: `rule:${c.rule_id}`, item_ids: c.item_ids, dedupe_key: `${c.dedupe_key}:${at.toISOString().slice(0, 13)}` }, w.id);
        engine.recordFiring(c, w.id, r.ok ? "wake_requested" : "wake_rejected", null, r.ok ? { wake_id: r.wake.id } : { error: r.error });
      }
    }

    if (!suggest.length) {
      engine.snapshot(world, w.id);
      log.info("wake.quiet", "No message candidates; stopping without a model call", undefined, w.id);
      return "no candidates";
    }

    const cap = settings.get().caps.unprompted_per_day;
    const sentToday = counters.get("messages.unprompted");
    // One model call ranks and drafts a couple of candidates: at most one goes out per wake;
    // anything beyond the cap is drafted for the brief. The rest come back on later wakes.
    const allowed = sentToday >= cap ? 2 : Math.min(2, settings.get().caps.max_per_wake + 1);
    const since = DateTime.fromJSDate(clock.now()).setZone(settings.tz()).startOf("day").toUTC().toISO()!;
    const recent = messages.list({ since, kinds: ["nudge"], limit: 10 }).map((m) => m.headline);
    const drafted = await this.drafter.draft(suggest, { allowed, wakeId: w.id, recentHeadlines: recent });

    let sent = 0,
      queued = 0,
      failed = 0,
      deferred = 0,
      held = 0;
    for (const { candidate, draft } of drafted.drafts) {
      const result = validateMessage(draft, {
        now: clock.now(),
        tz: settings.tz(),
        getItem: (id) => items.get(id),
        projectTitle: (id) => items.get(id)?.title ?? null,
        ruleAllowsMessaging: (id) => rules.isMessagingAllowed(id),
        candidate,
        recentlySent: (key) => messages.recentlySent(key, candidate.cooldown_hours),
        allowCompletionAck: false,
      });
      if (!result.ok || !result.rendered) {
        failed++;
        engine.recordFiring(candidate, w.id, "validator_failed", null, { errors: result.errors, draft });
        log.warn("validator.failed", `Validator stopped a ${candidate.rule_name} message: ${result.errors.join("; ")}`, { draft, errors: result.errors, drafted_by: drafted.draftedBy }, w.id);
        continue;
      }
      log.info("validator.passed", `Validator passed: ${result.rendered.headline}`, { rule: candidate.rule_name }, w.id);
      const out = await this.dispatcher.dispatch(candidate, draft, result.rendered, world, w.id, drafted.draftedBy, sent);
      if (out.kind === "sent") {
        sent++;
        engine.recordFiring(candidate, w.id, "message_sent", out.message.id);
      } else if (out.kind === "queued") {
        queued++;
        engine.recordFiring(candidate, w.id, "queued_for_brief", out.message.id, { reason: out.reason });
      } else if (out.kind === "deferred") {
        deferred++;
        engine.recordFiring(candidate, w.id, "deferred", null, { reason: out.reason, until: out.until });
      } else if (out.kind === "held") {
        held++;
        engine.recordFiring(candidate, w.id, "held", null, { reason: out.reason });
      } else {
        engine.recordFiring(candidate, w.id, "dropped", null, { reason: out.reason });
      }
    }
    for (const s of drafted.skipped) engine.recordFiring(s.candidate, w.id, "not_selected", null, { why: s.why });
    for (const f of drafted.followUps) {
      scheduler.request({ kind: "planner", at: f.at, reason: f.reason, owner: "ava:wake", item_ids: f.item_ids }, w.id);
    }
    engine.snapshot(engine.world(), w.id);
    return `${suggest.length} candidates: ${sent} sent, ${queued} queued, ${deferred} deferred, ${held} held, ${failed} failed validation (${drafted.draftedBy.replace("_", " ")})`;
  }

  private async pingDeadman(): Promise<void> {
    const url = this.svc.cfg.deadmanPingUrl;
    if (!url || this.svc.clock.simulated) return;
    try {
      await fetch(url, { method: "GET", signal: AbortSignal.timeout(5000) });
    } catch (e) {
      this.svc.log.warn("deadman.ping_failed", `External dead-man ping failed: ${(e as Error).message}`);
    }
  }
}

function nextLocalTime(now: Date, hhmm: string, tz: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  let d = DateTime.fromJSDate(now).setZone(tz).set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (d.toJSDate() <= now) d = d.plus({ days: 1 });
  return d.toJSDate();
}
