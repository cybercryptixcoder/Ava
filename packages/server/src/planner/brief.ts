import { z } from "zod";
import { DateTime } from "luxon";
import { formatClock, parseScript, type BriefView, type HydratedModule, type ModuleSpec } from "@ava/shared";
import type { Services } from "../core/services";
import { j, js, newId } from "../db/db";
import { BudgetExceededError, ModelUnavailableError } from "../models/types";
import { detectAffirmations } from "../conversation/affirmation";
import { STATE_OF_MIND } from "../validator/message-validator";

const BriefOutput = z.object({ spoken: z.string(), first_line: z.string() });

/**
 * The morning brief: the daily anchor. The modules are built by the system
 * from real state; the model only writes the short spoken version that
 * points at them (under a minute), and it is checked like any operational
 * message. Without a model the brief is composed from templates.
 */
export class BriefComposer {
  constructor(private svc: Services) {}

  private specs(date: string, artifactIds: string[], ruleIds: string[]): ModuleSpec[] {
    const specs: ModuleSpec[] = [
      { key: "day", type: "day_timeline", title: "Today", date },
      { key: "deadlines", type: "deadline_horizon", title: "Coming up", days: 7 },
    ];
    for (const a of artifactIds.slice(0, 3)) specs.push({ key: `prep-${a.slice(-5)}`, type: "artifact_preview", artifact_id: a });
    for (const r of ruleIds.slice(0, 3)) specs.push({ key: `rule-${r.slice(-5)}`, type: "rule_card", rule_id: r, title: "Rule waiting for you" });
    return specs;
  }

  async compose(wakeId: string): Promise<string> {
    const svc = this.svc;
    const { clock, settings, messages, questions, rules, db, canvas, log, models, cfg, personality, scheduler, items, planner } = svc;
    const tz = settings.tz();
    const now = clock.now();
    const local = DateTime.fromJSDate(now).setZone(tz);
    const date = local.toISODate()!;
    if (db.get("SELECT id FROM briefs WHERE date = ?", [date])) return "brief already composed today";

    const queued = messages.queuedForBrief();
    const question = questions.open();
    const proposals = rules.list().proposed;
    const lastBrief = db.get<{ created_at: string }>("SELECT created_at FROM briefs ORDER BY created_at DESC LIMIT 1");
    const since = lastBrief?.created_at ?? new Date(now.getTime() - 86_400_000).toISOString();
    const prepared = db.all<{ id: string }>("SELECT a.id FROM artifacts a JOIN exec_tasks t ON t.id = a.exec_task_id WHERE a.created_at >= ? AND t.spec LIKE '%\"silent\":true%'", [since]).map((r) => r.id);

    const modules: HydratedModule[] = [];
    for (const spec of this.specs(date, prepared, proposals.map((p) => p.id))) {
      const r = canvas.hydrator.hydrate(spec);
      if (r.ok) modules.push(r.module);
      else log.warn("canvas.invalid", `Brief module ${spec.key} failed: ${r.errors.join("; ")}`, undefined, wakeId);
    }

    const day = modules.find((m) => m.key === "day");
    const events = day?.data.type === "day_timeline" ? day.data.entries.filter((e) => e.kind === "event") : [];
    const checkins = scheduler.between(now, local.endOf("day").toJSDate()).filter((w) => ["lookahead", "planner", "rule", "deadline"].includes(w.kind) && w.status === "pending");
    const deadlines = modules.find((m) => m.key === "deadlines");
    const dueSoon = deadlines?.data.type === "deadline_horizon" ? deadlines.data.items : [];
    const completedYesterday = db.all<{ item_id: string }>("SELECT DISTINCT item_id FROM item_history WHERE field = 'status' AND new_value IN ('done','closed') AND at >= ?", [
      local.minus({ days: 1 }).startOf("day").toUTC().toISO()!,
    ]);
    const blocks = db.all<{ title: string; start_at: string }>("SELECT title, start_at FROM plan_blocks WHERE status = 'planned' AND start_at >= ? AND start_at <= ? ORDER BY start_at", [
      local.startOf("day").toUTC().toISO()!,
      local.endOf("day").toUTC().toISO()!,
    ]);

    const facts = [
      `Date: ${local.toFormat("cccc d LLLL")}. Location: ${settings.location().label}.`,
      `Calendar today: ${events.map((e) => `${e.title} at ${formatClock(e.start, tz)}`).join("; ") || "nothing"}.`,
      `Ava's plan for today: ${blocks.map((b) => `${b.title} at ${formatClock(b.start_at, tz)}`).join("; ") || "no planned blocks"}.`,
      `Ava will check in: ${checkins.map((w) => `${formatClock(w.due_at, tz)} (${w.reason})`).join("; ") || "only at the usual heartbeats"}.`,
      `Due in the next 7 days: ${dueSoon.map((d) => `${d.title} (${d.due_phrase}, ${d.status_label.toLowerCase()})`).join("; ") || "nothing"}.`,
      `Queued overnight: ${queued.map((m) => `${m.headline} — ${m.because}`).join("; ") || "nothing"}.`,
      `Prepared overnight: ${prepared.length ? `${prepared.length} item(s), shown on screen` : "nothing"}.`,
      `Question for him: ${question ? question.text : "none"}.`,
      `Rule proposals awaiting approval: ${proposals.map((p) => p.name).join("; ") || "none"}.`,
      `Finished yesterday: ${items.byIds(completedYesterday.map((c) => c.item_id)).map((i) => i.title).join("; ") || "nothing recorded"}.`,
      planner.latestBriefNotes() ? `Planner's notes for this brief: ${planner.latestBriefNotes()}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    let spoken = "";
    let firstLine = "";
    let draftedBy: "model" | "fallback_template" = "model";
    try {
      const res = await models.complete({
        purpose: "brief.compose",
        origin: "system",
        model: cfg.models.conversation,
        maxTokens: 1500,
        effort: "low",
        wakeId,
        schema: BriefOutput,
        system: [
          { text: `${personality.voice()}\n\n${personality.operational()}\n\n${personality.spoken()}`, cache: true },
          {
            text: `Write the spoken part of this morning's brief. It plays when he opens it, while the screen shows the details, so it must stay under a minute (about 130 words). Point first. Never read a list aloud: summarize and point to the screen. The screen shows modules with these keys: ${modules.map((m) => `${m.key} (${m.title})`).join(", ")}${question ? ", question" : ""}${queued.length ? ", queued" : ""}. Put a cue token like [[day]] right before the sentence that refers to a module so it appears as you say it. If there is a question, ask it once, near the end. No praise unless acknowledging something he really finished yesterday. first_line: the single most important point, for the notification.`,
            cache: false,
          },
        ],
        messages: [{ role: "user", content: facts }],
      });
      if (!res.parsed) throw new Error(res.parseError ?? "no output");
      spoken = res.parsed.spoken;
      firstLine = res.parsed.first_line;
      const plain = parseScript(spoken).text;
      const praise = detectAffirmations(plain);
      const mind = STATE_OF_MIND.exec(plain);
      const words = plain.split(/\s+/).length;
      if ((praise.length && !completedYesterday.length) || mind || words > 190) {
        log.warn("brief.rejected_draft", `Brief draft failed checks (${[praise.length ? "praise" : "", mind ? "state of mind" : "", words > 190 ? `${words} words` : ""].filter(Boolean).join(", ")}); using the template`, { spoken }, wakeId);
        throw new Error("draft failed checks");
      }
    } catch (e) {
      if (!(e instanceof ModelUnavailableError) && !(e instanceof BudgetExceededError)) log.warn("brief.fallback", `Brief uses the template: ${(e as Error).message}`, undefined, wakeId);
      draftedBy = "fallback_template";
      const first = events[0];
      const parts = [
        `[[day]]${events.length ? `${events.length === 1 ? "One thing" : `${events.length} things`} on the calendar today, starting with ${first.title} at ${formatClock(first.start, tz)}.` : "Nothing on the calendar today."}`,
        checkins.length ? `I'll check in at ${formatClock(checkins[0].due_at, tz)}${checkins.length > 1 ? ` and ${checkins.length - 1} more time${checkins.length > 2 ? "s" : ""}` : ""}.` : "",
        dueSoon.length ? `[[deadlines]]${dueSoon[0].title} is due ${dueSoon[0].due_phrase}${dueSoon.length > 1 ? `, and ${dueSoon.length - 1} more this week are on screen` : ""}.` : "",
        queued.length ? `${queued.length === 1 ? "One message" : `${queued.length} messages`} waited overnight; they're below.` : "",
        proposals.length ? `${proposals.length === 1 ? "A rule proposal needs" : `${proposals.length} rule proposals need`} your yes or no.` : "",
        question ? `One question: ${question.text}` : "",
      ];
      spoken = parts.filter(Boolean).join(" ");
      firstLine = dueSoon.length ? `${dueSoon[0].title} is due ${dueSoon[0].due_phrase}` : events.length ? `${events.length} on the calendar today` : "Your brief is ready";
    }

    const id = newId("brf");
    db.run("INSERT INTO briefs (id, date, spoken, modules, question_id, message_ids, drafted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      id,
      date,
      spoken,
      js(modules.map((m) => m.spec)),
      question?.id ?? null,
      js(queued.map((m) => m.id)),
      draftedBy,
      now.toISOString(),
    ]);
    messages.markInBrief(queued.map((m) => m.id));
    if (question) questions.markAsked(question.id);
    // Pre-render the spoken brief so it plays the moment he opens it.
    if (svc.voice.ttsAvailable("async")) {
      void svc.voice
        .renderAsync(spoken, { purpose: "brief", operational: true })
        .then((audio) => audio && db.run("UPDATE briefs SET audio_id = ? WHERE id = ?", [audio.audio_id, id]))
        .catch((e) => log.warn("brief.tts_failed", `Couldn't pre-render brief audio: ${(e as Error).message}`));
    }
    await svc.channels.notify(firstLine, "Your morning brief is ready.", "/today?brief=1", id);
    svc.bus.emit({ type: "brief.ready", brief_id: id });
    log.info("brief.composed", `Morning brief composed (${draftedBy.replace("_", " ")}): ${firstLine}`, { brief_id: id, queued: queued.length, question: question?.id ?? null }, wakeId);
    return `brief composed (${queued.length} queued messages, ${proposals.length} rule proposals)`;
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
