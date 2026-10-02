import { DateTime } from "luxon";
import type { Services } from "../core/services";
import { SimClock } from "../core/clock";
import { js, newId } from "../db/db";
import { AVA_REPLY, BELIEFS, BRAIN_DUMP, CALENDAR, COURSES, DRAFT_TO_LEE, ITEMS, PRACTICE_SET, type FxItem } from "./profile";

const TZ = "America/New_York";

/**
 * Seed the test profile. The morning of day D is produced by actually
 * running the system on a simulated clock (heartbeat, brief), so the log,
 * messages and validator decisions are real outputs, not hand-written rows.
 * Model calls are disabled while seeding; wakes fall back to templates.
 */
export async function seedTestProfile(svc: Services, opts: { anchor?: string } = {}): Promise<string> {
  if (svc.cfg.profile !== "test") throw new Error("Fixtures only go into the test profile");
  if (!(svc.clock instanceof SimClock)) throw new Error("The test profile needs a simulated clock");
  const clock = svc.clock;
  const provider = (svc.models as unknown as { provider: unknown }).provider;
  svc.models.setProvider(null);

  const anchorDay = opts.anchor ? DateTime.fromISO(opts.anchor, { zone: TZ }).startOf("day") : DateTime.now().setZone(TZ).startOf("day");
  const at = (d: number, hm: string) => {
    const [h, m] = hm.split(":").map(Number);
    return anchorDay.plus({ days: d }).set({ hour: h, minute: m }).toUTC().toISO()!;
  };
  const { items, db, beliefs, rules, settings, evidence, proposals } = svc;
  settings.update({ current_location_id: "state-college", first_run_complete: true, voice: { ...settings.get().voice, vocabulary: ["CMPSC 465", "CMPSC 473", "MATH 486", "Riya", "Prof. Lee", "Dijkstra", "Bellman-Ford", "I-20", "SOP"] } }, new Date(at(-60, "12:00")));

  // ------------------------------------------------------------ calendar: courses for three weeks around D
  clock.set(at(-30, "09:00"));
  for (let d = -14; d <= 14; d++) {
    const day = anchorDay.plus({ days: d });
    for (const c of COURSES) {
      if (!c.days.includes(day.weekday)) continue;
      items.upsertExternal("ics:fixture", `${c.code}:${day.toISODate()}`, {
        type: "event",
        title: c.title,
        start_at: at(d, c.start),
        end_at: at(d, c.end),
        data: { kind: "class", location: c.where, calendar: "Fall courses", busy: true },
        tags: [c.code],
      });
    }
  }
  for (const e of CALENDAR) {
    items.upsertExternal("gcal", `fixture:${e.key}`, { type: "event", title: e.title, start_at: at(...e.start!), end_at: at(...e.end!), data: { calendar: "Personal", busy: true, ...e.data } });
  }

  // ------------------------------------------------------------ items with history
  const ids = new Map<string, string>();
  const ordered = [...ITEMS].sort((a, b) => (a.type === "project" ? -1 : 0) - (b.type === "project" ? -1 : 0));
  for (const fx of ordered) {
    clock.set(at(...(fx.created ?? [-3, "12:00"])));
    const it = items.create(
      {
        type: fx.type,
        title: fx.title,
        due_at: fx.due ? at(...fx.due) : null,
        project_id: fx.project ? ids.get(fx.project) : null,
        importance: fx.importance ?? null,
        tags: fx.tags ?? [],
        data: fx.data ?? {},
      },
      { source: fx.source ?? "voice", via: "seed", source_ref: fx.source ? `fixture:${fx.key}` : null },
    );
    ids.set(fx.key, it.id);
    if (fx.status && fx.status !== it.status) {
      clock.set(at(...(fx.statusSince ?? fx.created ?? [-1, "12:00"])));
      items.update(it.id, { status: fx.status }, "seed");
    }
    if (fx.touched) db.run("UPDATE items SET touched_at = ? WHERE id = ?", [at(...fx.touched), it.id]);
  }
  // A few completions over the last two weeks for charts.
  const done: [string, number, string][] = [
    ["MATH 486 Problem Set 4", -6, "23:40"],
    ["CMPSC 465 Homework 3", -5, "22:10"],
    ["OS Project 1 writeup", -9, "21:30"],
    ["Email the international office", -4, "10:30"],
    ["CMPSC 465 Quiz 3 prep", -8, "23:50"],
    ["Robotics club budget form", -11, "16:20"],
    ["Recommendation letter reminder to Dr. Shah", -2, "09:15"],
  ];
  for (const [title, d, hm] of done) {
    clock.set(at(d - 2, "12:00"));
    const it = items.create({ type: "task", title }, { source: "voice", via: "seed" });
    clock.set(at(d, hm));
    items.complete(it.id, "seed");
  }

  // ------------------------------------------------------------ beliefs
  for (const b of BELIEFS) {
    clock.set(at(-b.daysAgo, "21:00"));
    const evId = evidence.add({ kind: "transcript", source: "voice", content: `(fixture) ${b.statement}`, summary: b.statement });
    beliefs.add({ area: b.area, statement: b.statement, provenance: b.provenance, confidence: b.confidence, evidence_ids: [evId] });
  }

  // ------------------------------------------------------------ activity sessions (three weeks) for rhythms
  const rand = mulberry32(465);
  for (let d = -21; d <= -1; d++) {
    const day = anchorDay.plus({ days: d });
    const blocks: [string, string, string, string][] = [
      ["Visual Studio Code", "shell.c — os-project-2", "14:" + String(10 + Math.floor(rand() * 30)).padStart(2, "0"), "coding"],
      ["Preview", "lecture-14-shortest-paths.pdf", "21:" + String(Math.floor(rand() * 40)).padStart(2, "0"), "study"],
      ["Google Chrome", "Overleaf — statement-of-purpose", "22:" + String(10 + Math.floor(rand() * 30)).padStart(2, "0"), "writing"],
      ["Safari", "YouTube — lofi", "23:" + String(Math.floor(rand() * 30)).padStart(2, "0"), "entertainment"],
    ];
    if (day.weekday === 6 || day.weekday === 7) blocks.splice(0, 1);
    for (const [app, title, start, category] of blocks) {
      const s = DateTime.fromISO(`${day.toISODate()}T${start}`, { zone: TZ });
      const mins = 35 + Math.floor(rand() * 70);
      db.run(
        "INSERT INTO activity_sessions (id, device, app, title_enc, started_at, ended_at, active_seconds, label, category, labeled_at, purge_title_after) VALUES (?, 'macbook', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [newId("act"), app, svc.cipher.encrypt(title), s.toUTC().toISO()!, s.plus({ minutes: mins }).toUTC().toISO()!, Math.round(mins * 60 * (0.7 + rand() * 0.25)), title.split(" — ")[0], category, s.toUTC().toISO()!, s.plus({ days: 3 }).toUTC().toISO()!],
      );
    }
  }
  svc.rhythms.recompute();

  // ------------------------------------------------------------ snapshots over the last three days (for shadow mode)
  for (let d = -3; d <= -1; d++) {
    for (const hm of ["08:00", "11:00", "14:00", "17:00", "19:40", "20:00", "22:00"]) {
      clock.set(at(d, hm));
      svc.engine.snapshot(svc.engine.world(), null);
    }
  }

  // ------------------------------------------------------------ rules: one active dynamic, one proposed, one self-paused
  clock.set(at(-12, "21:00"));
  const evening = rules.propose({
    name: "Evening study window",
    evidence: "You acted on 4 of 5 study nudges sent 7–9pm and ignored all 3 sent before noon.",
    definition: {
      when: { all: [{ field: "now.local_hour", op: "between", value: [19, 21.5] }] },
      for_each: { type: "task", where: { all: [{ field: "item.kind", op: "in", value: ["quiz", "exam"] }, { field: "item.status", op: "eq", value: "todo" }, { field: "item.days_until_due", op: "lte", value: 3 }] } },
      limit: 1,
      action: { kind: "suggest", intent: "Start prep for the nearest quiz during the evening study window", options: ["Make a practice set", "Do 30 minutes now"] },
      cooldown_hours: 20,
      category: "study",
    },
    expiry_days: 21,
    created_by: "planner",
  });
  if (evening.ok) rules.approve(evening.rule.id, "user");

  clock.set(at(-16, "21:00"));
  const morning = rules.propose({
    name: "Morning reading nudge",
    evidence: "Reading list items piled up; tried nudging them before classes.",
    definition: {
      when: { all: [{ field: "now.local_hour", op: "between", value: [8, 10] }] },
      for_each: { type: "task", where: { field: "item.kind", op: "eq", value: "reading" } },
      limit: 1,
      action: { kind: "suggest", intent: "Read one section before class" },
      cooldown_hours: 20,
      category: "reading",
    },
    expiry_days: 30,
    created_by: "planner",
  });
  if (morning.ok) {
    rules.approve(morning.rule.id, "user");
    const responses: (string | null)[] = ["not_now", "not_now", "less_of_this", null, "do_it"];
    responses.forEach((r, i) => {
      clock.set(at(-15 + i * 2, "08:40"));
      const m = svc.messages.create({
        kind: "nudge",
        rule_id: morning.rule.id,
        wake_id: null,
        headline: "Read DDIA chapter 5 on replication",
        because: "Read DDIA chapter 5 on replication is not started.",
        cited: [ids.get("ddia")!],
        options: [
          { key: "o1", label: "Summarize the chapter for me", action: { kind: "start_executor", executor: "summary", item_id: ids.get("ddia")!, instructions: "Summarize DDIA chapter 5" } },
          { key: "o2", label: "Remind me tonight", action: { kind: "snooze_item", item_id: ids.get("ddia")!, hours: 12 } },
        ],
        urgency: "today",
        status: "sent",
        drafted_by: "model",
      });
      svc.engine.recordFiring({ rule_id: morning.rule.id, dedupe_key: `${morning.rule.id}:${i}`, item_ids: [ids.get("ddia")!] } as never, null, "message_sent", m.id);
      if (r) {
        clock.set(at(-15 + i * 2, "09:05"));
        svc.messages.recordResponse(m.id, r as never, r === "do_it" ? "o1" : null, r === "do_it");
      }
    });
    clock.set(at(-6, "09:10"));
    rules.checkSelfPause(morning.rule.id);
  }

  // Evening-rule history: 4 of 5 acted.
  if (evening.ok) {
    [true, true, false, true, true].forEach((acted, i) => {
      clock.set(at(-11 + i * 2, "19:45"));
      const m = svc.messages.create({
        kind: "nudge",
        rule_id: evening.rule.id,
        wake_id: null,
        headline: "Start prep for the next quiz",
        because: "The quiz is coming up and is not started.",
        cited: [ids.get("quiz4")!],
        options: [{ key: "o1", label: "Make a practice set", action: { kind: "start_executor", executor: "practice_set", item_id: ids.get("quiz4")!, instructions: "Practice set" } }, { key: "o2", label: "Not tonight", action: { kind: "none" } }],
        urgency: "today",
        status: "sent",
        drafted_by: "model",
      });
      svc.engine.recordFiring({ rule_id: evening.rule.id, dedupe_key: `${evening.rule.id}:h${i}`, item_ids: [ids.get("quiz4")!] } as never, null, "message_sent", m.id);
      clock.set(at(-11 + i * 2, "19:52"));
      svc.messages.recordResponse(m.id, acted ? "do_it" : "not_now", acted ? "o1" : null, acted);
    });
  }

  clock.set(at(-1, "21:40"));
  const proposed = rules.propose({
    name: "Right after 465 lecture",
    evidence: "Twice last week you opened the 465 slides within 20 minutes of lecture ending and finished the homework faster those days.",
    definition: {
      when: { all: [{ field: "calendar.minutes_since_class_ended", op: "between", value: [0, 30] }, { field: "calendar.in_class", op: "eq", value: false }] },
      for_each: { type: "task", where: { all: [{ field: "item.course", op: "eq", value: "CMPSC 465" }, { field: "item.status", op: "eq", value: "todo" }] } },
      limit: 1,
      action: { kind: "suggest", intent: "Use the half hour after 465 lecture to start the quiz prep while it's fresh", options: ["Start with three problems", "Make a practice set"] },
      cooldown_hours: 20,
      category: "study",
    },
    expiry_days: 14,
    created_by: "planner",
  });
  if (proposed.ok) rules.shadow(proposed.rule.id);
  clock.set(at(-1, "21:41"));
  rules.propose({
    name: "Prepare quiz practice two days out",
    evidence: "You said practice problems work better for you than re-reading; preparing a set two days before each quiz removes the first step.",
    definition: {
      for_each: { type: "task", where: { all: [{ field: "item.kind", op: "eq", value: "quiz" }, { field: "item.days_until_due", op: "eq", value: 2 }] } },
      limit: 1,
      action: { kind: "prepare", executor: "practice_set", instructions: "A practice set matched to the quiz's topics, easy to hard" },
      cooldown_hours: 48,
      category: "study",
    },
    expiry_days: 21,
    created_by: "planner",
  });

  // ------------------------------------------------------------ evening plan from yesterday
  clock.set(at(-1, "21:32"));
  const planId = newId("pln");
  db.run("INSERT INTO plans (id, kind, for_date, content, model_call_id, created_at) VALUES (?, 'evening', ?, ?, NULL, ?)", [
    planId,
    anchorDay.toISODate(),
    js({
      plan_note: "Finish the SOP read-through tonight and start quiz prep with problems after OS lecture.",
      blocks: [],
      wake_requests: [],
      rule_proposals: [],
      question: null,
      belief_proposals: [],
      brief_notes: "The SOP has been drafted for four days; the last step is one read-through.",
    }),
    at(-1, "21:32"),
  ]);
  for (const [title, key, s, e, note] of [
    ["Quiz 4 prep: shortest paths problems", "quiz4", "15:05", "16:05", "Problems, not slides"],
    ["SOP final read-through", "sop", "21:30", "22:15", "One pass, then send"],
  ] as const) {
    db.run("INSERT INTO plan_blocks (id, plan_id, item_id, title, start_at, end_at, note, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned')", [newId("blk"), planId, ids.get(key)!, title, at(0, s), at(0, e), note]);
  }
  svc.questions.add({ text: "Does the robotics line follower still matter to you this semester?", why: "It's marked important but untouched for nine days, and you sounded unsure about it.", about: { item_id: ids.get("p_robot") } });

  // ------------------------------------------------------------ executor artifacts
  clock.set(at(-1, "22:05"));
  const exec = (kind: string, title: string, itemKey: string, body: unknown) => {
    const tid = newId("exe");
    db.run("INSERT INTO exec_tasks (id, kind, title, spec, item_id, origin, status, sessions_run, max_sessions, progress_note, plan_fit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'user', 'done', 1, 6, ?, ?, ?, ?)", [
      tid,
      kind,
      title,
      js({ instructions: title, silent: false }),
      ids.get(itemKey)!,
      "Complete",
      js({ fits: true, note: "Quiz is three days out and nothing is started; a practice set is the right first step." }),
      clock.now().toISOString(),
      clock.now().toISOString(),
    ]);
    const aid = newId("art");
    db.run("INSERT INTO artifacts (id, exec_task_id, item_id, kind, title, body_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [aid, tid, ids.get(itemKey)!, kind, title, svc.cipher.encJson(body), clock.now().toISOString()]);
    return aid;
  };
  const practiceId = exec("practice_set", "Quiz 4 practice set: shortest paths and MSTs", "quiz4", PRACTICE_SET);
  const draftId = exec("draft", "Reply to Prof. Lee", "lee", DRAFT_TO_LEE);
  svc.actions.prepareEmail({ to: "lee@psu.edu", subject: DRAFT_TO_LEE.subject, body: DRAFT_TO_LEE.body }, draftId);

  // ------------------------------------------------------------ the morning, run for real on the simulated clock
  clock.set(at(0, "07:55"));
  db.run("UPDATE wakes SET status = 'cancelled', outcome = 'reset for seed' WHERE status = 'pending'");
  svc.scheduler.ensureSystemWakes();
  for (const it of items.list({ open: true, types: ["task", "commitment"] })) if (it.due_at) svc.scheduler.syncDeadlineWakes(it);
  await svc.scheduler.advanceTo(new Date(at(0, "11:52")));

  // ------------------------------------------------------------ the conversation on the canvas
  clock.set(at(0, "11:40"));
  const conv = svc.canvas.current(true);
  const userTurn = svc.conversation.saveTurn({ convId: conv, role: "user", mode: "async", text: BRAIN_DUMP, input_kind: "dictated" });
  const ev = evidence.add({ kind: "transcript", source: "voice", content: BRAIN_DUMP, summary: BRAIN_DUMP.slice(0, 200), source_ref: userTurn.id });
  const batch = proposals.createBatch("conversation", [
    { change: { op: "set_status", item_id: ids.get("riya")!, status: "open" }, summary: "Keep \"Send Riya the robotics club slides\" open (you haven't sent them)", reason: "I told Riya I'd send her the robotics slides yesterday and I completely forgot", evidence_id: ev },
    { change: { op: "update_item", item_id: ids.get("os2")!, patch: { data: { notes: "Parser working" } } }, summary: "OS Project 2: note that the parser works", reason: "I got the parser working", evidence_id: ev },
    {
      change: { op: "add_belief", belief: { area: "study", statement: "Re-reading slides doesn't help you prepare; practice problems do.", provenance: "stated", confidence: 0.9 } },
      summary: "Note: re-reading slides doesn't help you; problems do",
      reason: "I end up re-reading the slides which doesn't help",
      evidence_id: ev,
    },
    {
      change: { op: "create_item", item: { type: "commitment", title: "Get the I-20 signed before winter break (office open weekdays until 4)", due_at: at(9, "16:00"), data: { kind: "errand" } } },
      summary: "New: get the I-20 signed, office open weekdays until 4",
      reason: "I need to get the I-20 signed before winter break, the office is only open weekdays till four",
      evidence_id: ev,
    },
  ]);
  svc.canvas.show(conv, { key: "chips", type: "confirmation_chips", batch_id: batch.batch_id, title: "From what you said" }, "seed");
  clock.set(at(0, "11:41"));
  svc.canvas.show(conv, { key: "plan", type: "day_timeline", title: "Today", highlight_item_ids: [ids.get("sop")!, ids.get("quiz4")!] }, "seed");
  svc.canvas.show(conv, { key: "deadlines", type: "deadline_horizon", title: "Due in the next two weeks", days: 14 }, "seed");
  svc.canvas.show(
    conv,
    {
      key: "opts",
      type: "options",
      title: "Start the quiz prep",
      prompt: "Pick one; I'll start it now.",
      recommended: "a",
      options: [
        { key: "a", label: "Practice set, easy to hard", detail: "Twelve problems on Dijkstra, Bellman-Ford and MSTs, answers hidden", action: { kind: "start_executor", executor: "practice_set", item_id: ids.get("quiz4")!, instructions: "Practice set on shortest paths and MSTs" } },
        { key: "b", label: "Three problems right after lecture", detail: "A 30-minute start while the material is fresh", action: { kind: "start_executor", executor: "plan", item_id: ids.get("quiz4")!, instructions: "30-minute plan: three problems" } },
        { key: "c", label: "Remind me tonight", detail: "In the 9 pm study window", action: { kind: "snooze_item", item_id: ids.get("quiz4")!, hours: 9 } },
      ],
    },
    "seed",
  );
  const raw = `${AVA_REPLY}\n<show>{"key":"plan","type":"day_timeline"}</show>`;
  svc.conversation.saveTurn({ convId: conv, role: "ava", mode: "async", text: AVA_REPLY.replace(/\[\[[^\]]+\]\]/g, "").replace(/ {2,}/g, " "), raw });
  clock.set(at(0, "11:47"));
  svc.conversation.saveTurn({ convId: conv, role: "user", mode: "async", text: "do the practice set", input_kind: "dictated" });
  svc.canvas.show(conv, { key: "practice", type: "artifact_preview", artifact_id: practiceId, title: "Quiz 4 practice set" }, "seed");
  svc.conversation.saveTurn({
    convId: conv,
    role: "ava",
    mode: "async",
    text: "It's up. Twelve problems, easiest first; answers stay hidden until you open them. The Bellman-Ford pair is where quizzes like this usually bite.",
  });
  svc.canvas.event(conv, "choose_option", "opts", { option: "a", label: "Practice set, easy to hard" });
  db.run("UPDATE canvas_events SET consumed = 1");

  clock.set(at(0, "11:52"));
  db.run("INSERT INTO settings (key, value, updated_at) VALUES ('sim.clock', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [clock.now().toISOString(), new Date().toISOString()]);
  svc.models.setProvider(provider as never);
  return clock.now().toISOString();
}

function mulberry32(a: number) {
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type { FxItem };
