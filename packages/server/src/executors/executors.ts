import { z } from "zod";
import type { ArtifactBody, ArtifactView, ExecTaskView } from "@ava/shared";
import type { Services } from "../core/services";
import { j, js, newId } from "../db/db";
import { BudgetExceededError, ModelUnavailableError } from "../models/types";

export type ExecKind = "practice_set" | "summary" | "draft" | "outline" | "plan";

const OutputSchema = z.object({
  artifact: z.object({
    title: z.string(),
    practice_set: z.object({ intro: z.string(), questions: z.array(z.object({ q: z.string(), answer: z.string(), hint: z.string().nullable() })) }).nullable(),
    draft: z.object({ to: z.string().nullable(), subject: z.string().nullable(), body: z.string(), notes: z.string().nullable() }).nullable(),
    summary: z.object({ sections: z.array(z.object({ heading: z.string(), text: z.string() })) }).nullable(),
    outline: z.object({ sections: z.array(z.object({ heading: z.string(), points: z.array(z.string()) })) }).nullable(),
    plan: z.object({ steps: z.array(z.object({ label: z.string(), minutes: z.number().nullable() })), notes: z.string().nullable() }).nullable(),
  }),
  report: z.object({
    result: z.string(),
    plan_fit: z.object({ fits: z.boolean(), note: z.string() }),
    done: z.boolean(),
    progress_note: z.string(),
    next_focus: z.string().nullable(),
  }),
});
type Output = z.infer<typeof OutputSchema>;

const KIND_GUIDE: Record<ExecKind, string> = {
  practice_set: "Write a practice set: 6–12 questions that mirror what the assessment will likely test, ordered easy to hard, each with a worked answer and an optional hint. Fill artifact.practice_set.",
  summary: "Summarize where things stand: what's done, what's in progress, what's left, and the single next concrete step. Fill artifact.summary with 2–5 short sections.",
  draft: "Draft the message he owes, in his voice: direct, warm, short. Fill artifact.draft with to (name or address if known, else null), subject (if email), body. Never claim it was sent.",
  outline: "Write an outline that makes starting easy. Fill artifact.outline with sections and concrete points.",
  plan: "Write a short step plan sized to the time available, each step with minutes. Fill artifact.plan.",
};

const SYSTEM = `You are an executor session inside Ava, a personal agent. You were started fresh for one task and you only know what is in the task spec below. You do not know Ava's plans or reasoning, and you should not guess them.

Do the work and produce the artifact. Then report back honestly:
- result: one or two sentences on what you produced.
- plan_fit: does the plan behind this task still fit reality, given what you saw in the spec? If something looks off (the deadline already passed, the item seems done, the materials don't match), say so plainly. This note goes to the planner, who never grades its own plans.
- done: false only if the task genuinely needs another bounded session; then write progress_note (where you stopped) and next_focus.

You never send, submit or publish anything. Artifacts are for Shreyas to see.`;

function rowToTask(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    kind: r.kind as ExecKind,
    title: String(r.title),
    spec: j<{ instructions: string; silent: boolean }>(r.spec, { instructions: "", silent: false }),
    item_id: (r.item_id as string) ?? null,
    origin: String(r.origin),
    status: String(r.status),
    sessions_run: Number(r.sessions_run),
    max_sessions: Number(r.max_sessions),
    progress_note: (r.progress_note as string) ?? null,
    plan_fit: j<{ fits: boolean; note: string } | null>(r.plan_fit, null),
    error: (r.error as string) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

/**
 * Executors do the work Shreyas accepts ("make me a practice set", "draft the
 * reply"). Each session is a fresh model call that receives only the task
 * spec and the context it needs, never the planner's context. Long tasks run
 * as a series of bounded sessions, each requesting the next through the
 * scheduler.
 */
export class Executors {
  constructor(private svc: Services) {}

  private now() {
    return this.svc.clock.now().toISOString();
  }

  start(
    input: { kind: ExecKind; item_id: string | null; instructions: string; origin: string; silent: boolean },
    wakeId?: string | null,
  ): ExecTaskView | null {
    const { db, items, settings, scheduler, log, bus } = this.svc;
    const item = input.item_id ? items.get(input.item_id) : null;
    const titleBase = { practice_set: "Practice set", summary: "Summary", draft: "Draft", outline: "Outline", plan: "Plan" }[input.kind];
    const title = item ? `${titleBase}: ${item.title}` : `${titleBase}: ${input.instructions.slice(0, 60)}`;
    const id = newId("exe");
    db.run(
      "INSERT INTO exec_tasks (id, kind, title, spec, item_id, origin, status, max_sessions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
      [id, input.kind, title, js({ instructions: input.instructions, silent: input.silent }), input.item_id, input.origin, settings.get().executor.max_sessions, this.now(), this.now()],
    );
    log.info("exec.started", `Executor queued: ${title} (${input.origin})`, { exec_task_id: id }, wakeId);
    if (input.silent) {
      // Ava-initiated preparation goes through the scheduler's executor budget.
      const r = scheduler.request(
        { kind: "executor", at: new Date(this.svc.clock.now().getTime() + 2 * 60_000), reason: `Prepare ${title}`, owner: `executor:${id}`, item_ids: input.item_id ? [input.item_id] : [], payload: { exec_task_id: id } },
        wakeId,
      );
      if (!r.ok) {
        db.run("UPDATE exec_tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", [r.error, this.now(), id]);
        return null;
      }
    } else {
      // Shreyas asked for it: start now, in the background.
      void this.runSession(id, null).catch((e) => log.error("exec.error", `Executor ${id} failed: ${(e as Error).message}`));
    }
    bus.emit({ type: "exec.updated", exec_task_id: id, status: "queued" });
    return this.view(id);
  }

  /** Build the minimal context an executor needs: the item, its project, linked evidence. Nothing from planning. */
  private context(itemId: string | null): string {
    const { items, evidence, db, clock, settings } = this.svc;
    if (!itemId) return "No linked item.";
    const it = items.get(itemId);
    if (!it) return "The linked item no longer exists.";
    const tz = settings.tz();
    const h = items.hydrate(it, clock.now(), tz);
    const lines = [
      `Item: ${it.title} (${it.type})`,
      `Status: ${h.status_label}${h.due_phrase ? `; due ${h.due_phrase}` : ""}`,
      ...Object.entries(it.data)
        .filter(([k]) => k !== "snoozed_until")
        .map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "string" ? v : JSON.stringify(v)}`),
      it.tags.length ? `Tags: ${it.tags.join(", ")}` : "",
    ];
    if (it.project_id) {
      const p = items.get(it.project_id);
      if (p) lines.push(`Project: ${p.title}${p.data.next_step ? ` (next step: ${p.data.next_step})` : ""}`);
    }
    if (it.type === "project") {
      const tasks = items.list({ project_id: it.id });
      lines.push("Project tasks:", ...tasks.map((t) => `- ${t.title} [${t.status}]${t.due_at ? ` due ${t.due_at.slice(0, 10)}` : ""}`));
      const hist = db.all<{ at: string; field: string; new_value: string; item_id: string }>(
        `SELECT at, field, new_value, item_id FROM item_history WHERE item_id IN (${[it.id, ...tasks.map((t) => t.id)].map(() => "?").join(",")}) ORDER BY id DESC LIMIT 20`,
        [it.id, ...tasks.map((t) => t.id)],
      );
      if (hist.length) lines.push("Recent changes:", ...hist.map((x) => `- ${x.at.slice(0, 10)} ${x.field} -> ${x.new_value}`));
    }
    const ev = db.all<{ evidence_id: string }>("SELECT evidence_id FROM item_evidence WHERE item_id = ? LIMIT 5", [itemId]);
    for (const e of ev) {
      const full = evidence.get(e.evidence_id);
      if (!full) continue;
      const text = typeof full.content === "string" ? full.content : JSON.stringify(full.content);
      lines.push(`Source note (${full.kind}, ${full.occurred_at.slice(0, 10)}): ${(full.summary ?? text).slice(0, 1500)}`);
    }
    return lines.filter(Boolean).join("\n");
  }

  async runSession(taskId: string, wakeId: string | null): Promise<string> {
    const { db, models, cfg, log, bus, scheduler, settings, clock } = this.svc;
    const r = db.get("SELECT * FROM exec_tasks WHERE id = ?", [taskId]);
    if (!r) return "task missing";
    const task = rowToTask(r);
    if (["done", "cancelled", "failed"].includes(task.status)) return `task already ${task.status}`;
    db.run("UPDATE exec_tasks SET status = 'running', updated_at = ? WHERE id = ?", [this.now(), taskId]);
    bus.emit({ type: "exec.updated", exec_task_id: taskId, status: "running" });
    const prev = db.get<{ body_enc: string }>("SELECT body_enc FROM artifacts WHERE exec_task_id = ? ORDER BY created_at DESC LIMIT 1", [taskId]);
    const prevBody = prev ? this.svc.cipher.decOpt(prev.body_enc) : null;
    let out: Output;
    try {
      const res = await models.complete({
        purpose: `executor.${task.kind}`,
        origin: task.spec.silent ? "system" : "interactive",
        model: cfg.models.executor,
        maxTokens: 8000,
        effort: "medium",
        wakeId,
        system: SYSTEM,
        schema: OutputSchema,
        messages: [
          {
            role: "user",
            content: `Task: ${task.kind.replace("_", " ")} — ${task.title}
Instructions: ${task.spec.instructions}
How to fill the artifact: ${KIND_GUIDE[task.kind]}
Session ${task.sessions_run + 1} of at most ${task.max_sessions}.
${task.progress_note ? `Progress note from the previous session: ${task.progress_note}\nPrevious artifact: ${prevBody?.slice(0, 6000)}` : ""}
Today is ${clock.now().toISOString().slice(0, 10)} (${settings.tz()}).

Context:
${this.context(task.item_id)}`,
          },
        ],
      });
      if (!res.parsed) throw new Error(res.parseError ?? "No output");
      out = res.parsed;
    } catch (e) {
      const msg = e instanceof ModelUnavailableError ? "No model key configured" : e instanceof BudgetExceededError ? e.message : (e as Error).message;
      db.run("UPDATE exec_tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", [msg, this.now(), taskId]);
      log.error("exec.failed", `Executor "${task.title}" failed: ${msg}`, { exec_task_id: taskId }, wakeId);
      bus.emit({ type: "exec.updated", exec_task_id: taskId, status: "failed" });
      return `failed: ${msg}`;
    }

    const body = toBody(task.kind, out);
    const artifactId = newId("art");
    db.run("INSERT INTO artifacts (id, exec_task_id, item_id, kind, title, body_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      artifactId,
      taskId,
      task.item_id,
      task.kind,
      out.artifact.title,
      this.svc.cipher.encJson(body),
      this.now(),
    ]);
    const sessions = task.sessions_run + 1;
    const more = !out.report.done && sessions < task.max_sessions;
    db.run("UPDATE exec_tasks SET status = ?, sessions_run = ?, progress_note = ?, plan_fit = ?, updated_at = ? WHERE id = ?", [
      more ? "needs_next" : "done",
      sessions,
      out.report.progress_note,
      js(out.report.plan_fit),
      this.now(),
      taskId,
    ]);
    log.info(
      "exec.reported",
      `Executor finished session ${sessions}: ${out.report.result}${out.report.plan_fit.fits ? "" : ` Plan check: ${out.report.plan_fit.note}`}`,
      { exec_task_id: taskId, artifact_id: artifactId, plan_fit: out.report.plan_fit },
      wakeId,
    );
    if (more) {
      const at = new Date(clock.now().getTime() + settings.get().executor.session_spacing_minutes * 60_000);
      scheduler.request({ kind: "executor", at, reason: `Continue ${task.title}: ${out.report.next_focus ?? "next session"}`, owner: `executor:${taskId}`, item_ids: task.item_id ? [task.item_id] : [], payload: { exec_task_id: taskId } }, wakeId);
    }
    if (!task.spec.silent) {
      this.svc.canvas.presentArtifact(artifactId);
      await this.svc.channels.notify(`${out.artifact.title} is ready`, out.report.result, `/talk?artifact=${artifactId}`, artifactId);
    }
    bus.emit({ type: "exec.updated", exec_task_id: taskId, status: more ? "needs_next" : "done" });
    return `${task.kind} session ${sessions}${more ? ", next session requested" : ", done"}`;
  }

  cancel(taskId: string): void {
    this.svc.db.run("UPDATE exec_tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND status NOT IN ('done','failed')", [this.now(), taskId]);
    this.svc.scheduler.pending({ kinds: ["executor"] }).filter((w) => w.payload.exec_task_id === taskId).forEach((w) => this.svc.scheduler.cancel(w.id, "user", "executor cancelled"));
  }

  artifact(id: string): ArtifactView | null {
    const { db, cipher, items } = this.svc;
    const r = db.get<{ id: string; exec_task_id: string | null; item_id: string | null; kind: ArtifactView["kind"]; title: string; body_enc: string; created_at: string }>(
      "SELECT * FROM artifacts WHERE id = ?",
      [id],
    );
    if (!r) return null;
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      item_id: r.item_id,
      item_title: r.item_id ? (items.get(r.item_id)?.title ?? null) : null,
      created_at: r.created_at,
      body: cipher.decJson<ArtifactBody>(r.body_enc, { kind: "summary", sections: [] }),
      exec_task_id: r.exec_task_id,
    };
  }

  view(id: string): ExecTaskView | null {
    const r = this.svc.db.get("SELECT * FROM exec_tasks WHERE id = ?", [id]);
    if (!r) return null;
    const t = rowToTask(r);
    const arts = this.svc.db.all<{ id: string }>("SELECT id FROM artifacts WHERE exec_task_id = ? ORDER BY created_at", [id]);
    return {
      id: t.id,
      kind: t.kind,
      title: t.title,
      status: t.status,
      item_id: t.item_id,
      sessions_run: t.sessions_run,
      max_sessions: t.max_sessions,
      progress_note: t.progress_note,
      plan_fit: t.plan_fit,
      artifacts: arts.map((a) => this.artifact(a.id)!).filter(Boolean),
      created_at: t.created_at,
      updated_at: t.updated_at,
    };
  }

  list(limit = 50): ExecTaskView[] {
    return this.svc.db.all<{ id: string }>("SELECT id FROM exec_tasks ORDER BY created_at DESC LIMIT ?", [limit]).map((r) => this.view(r.id)!);
  }

  /** Executor reports the planner reads in its next session (plan-fit feedback). */
  recentReports(sinceIso: string): { title: string; result: string | null; plan_fit: { fits: boolean; note: string } | null; status: string }[] {
    return this.svc.db
      .all<Record<string, unknown>>("SELECT * FROM exec_tasks WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT 20", [sinceIso])
      .map(rowToTask)
      .map((t) => ({ title: t.title, result: t.progress_note, plan_fit: t.plan_fit, status: t.status }));
  }
}

function toBody(kind: ExecKind, o: Output): ArtifactBody {
  const a = o.artifact;
  switch (kind) {
    case "practice_set":
      return { kind, intro: a.practice_set?.intro ?? "", questions: (a.practice_set?.questions ?? []).map((q) => ({ q: q.q, answer: q.answer, hint: q.hint ?? undefined })) };
    case "draft":
      return { kind, to: a.draft?.to ?? null, subject: a.draft?.subject ?? null, body: a.draft?.body ?? "", notes: a.draft?.notes ?? null };
    case "summary":
      return { kind, sections: a.summary?.sections ?? [] };
    case "outline":
      return { kind, sections: a.outline?.sections ?? [] };
    case "plan":
      return { kind, steps: a.plan?.steps ?? [], notes: a.plan?.notes ?? null };
  }
}
