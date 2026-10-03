import { z } from "zod";
import { parseScript } from "@ava/shared";
import type { Services } from "../core/services";
import { newId } from "../db/db";

const GradeSchema = z.object({ ok: z.boolean(), why: z.string().max(300) });

export interface EvalResult {
  scenario: string;
  question: string;
  ok: boolean;
  why: string;
  reply: string;
}

export interface EvalRunResult {
  id: string;
  at: string;
  via: string;
  passed: number;
  total: number;
  results: EvalResult[];
  duration_ms: number;
}

interface Scenario {
  name: string;
  replay: string[];
  question: string;
  kind: "answers" | "abstains" | "history";
  expected: string;
}

/**
 * Three things memory must get right, checked end to end with real keys:
 * a fact that was stated gets recalled; a truth that was never stored gets an
 * honest "I don't know"; a change is visible as history. Replay writes go
 * through the raw log and the real processing pipeline; questions are asked
 * through the same prompt assembly the conversation uses; answers are graded
 * by the cheap model. Everything the run plants is forgotten through the real
 * forget path when it ends — the evaluation leaves no residue.
 */
const SCENARIOS: Scenario[] = [
  {
    name: "direct recall",
    replay: ["my I-20 travel appointment is on Friday October 9 at ten in the morning, at the international office"],
    question: "when and where is my I-20 travel appointment?",
    kind: "answers",
    expected: "Friday, October 9, at ten in the morning, at the international office",
  },
  {
    name: "stays honest when the truth is missing",
    replay: [],
    question: "what did I decide about the kayaking trip across the Baltic sea?",
    kind: "abstains",
    expected: "no such trip is in memory; the reply must say plainly that it doesn't know rather than inventing anything",
  },
  {
    name: "a change is visible",
    replay: ["the robotics club meeting is Wednesday at five", "about the robotics club meeting — it moved to Thursday at five"],
    question: "did the robotics club meeting change, and when is it now?",
    kind: "history",
    expected: "the meeting moved from Wednesday to Thursday, and it is now Thursday at five",
  },
];

export class MemoryEval {
  private running = false;

  constructor(private svc: Services) {}

  async run(opts: { via: "manual" | "cli" | "consolidation"; maxScenarios?: number } = { via: "manual" }): Promise<EvalRunResult> {
    const { models, log } = this.svc;
    if (this.running) throw new Error("A memory evaluation is already running");
    if (!models.available) throw new Error("The memory evaluation needs a model key");
    this.running = true;
    const started = Date.now();
    const runId = newId("mev");
    const convId = `eval:${runId}`;
    const scenarios = SCENARIOS.slice(0, opts.maxScenarios ?? SCENARIOS.length);
    const results: EvalResult[] = [];
    try {
      for (const sc of scenarios) {
        for (const t of sc.replay) {
          this.svc.memory.append({ kind: "turn", source: "conversation", role: "user", session_id: convId, text: t, meta: { eval: runId } });
        }
        if (sc.replay.length) await this.svc.memoryProcessor.run({ maxBatches: 10 });
        const reply = await this.ask(convId, sc.question);
        this.svc.memory.append({ kind: "turn", source: "conversation", role: "ava", session_id: convId, text: reply, meta: { eval: runId } });
        const graded = await this.grade(sc, reply);
        results.push({ scenario: sc.name, question: sc.question, ok: graded.ok, why: graded.why, reply: reply.slice(0, 500) });
      }
    } finally {
      // Cleanup through the real forget path; nothing the run planted stays, derived layers included.
      try {
        const ids = this.svc.db.all<{ id: string }>("SELECT id FROM entries WHERE session_id = ? AND deleted_at IS NULL", [convId]).map((r) => r.id);
        if (ids.length) await this.svc.forgetFlow.apply(ids, "memory evaluation run");
      } catch (e) {
        log.warn("memory.eval", `Eval cleanup failed (entries stay until forgotten manually): ${(e as Error).message}`);
      }
      this.running = false;
    }
    const passed = results.filter((r) => r.ok).length;
    const at = this.svc.clock.now().toISOString();
    const duration = Date.now() - started;
    this.svc.db.run("INSERT INTO memory_eval_runs (id, at, via, passed, total, detail_enc, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      runId,
      at,
      opts.via,
      passed,
      results.length,
      this.svc.cipher.encJson(results),
      duration,
    ]);
    log.info("memory.eval", `Memory evaluation (${opts.via}): ${passed}/${results.length} passed${passed < results.length ? ` — missed: ${results.filter((r) => !r.ok).map((r) => r.scenario).join(", ")}` : ""}`, { run_id: runId, passed, total: results.length, duration_ms: duration });
    return { id: runId, at, via: opts.via, passed, total: results.length, results, duration_ms: duration };
  }

  /** Ask a question through the same assembly the conversation uses (core, pack, window) — without filing anything. */
  private async ask(convId: string, question: string): Promise<string> {
    const { models, cfg, settings, conversation } = this.svc;
    const pack = await this.svc.retriever.retrieve(question, { budgetTokens: settings.get().memory.context_budget_tokens });
    let out = "";
    await models.stream(
      {
        purpose: "memory.eval_reply",
        origin: "system",
        model: cfg.models.conversation,
        maxTokens: 500,
        system: await conversation.systemBlocks(false),
        messages: [
          ...conversation.window(convId, 0),
          {
            role: "user",
            content: `${await conversation.contextBlock(convId, question, false, ["Memory evaluation run: answer the question from memory, or say plainly that you don't know."], pack)}\n\n${question}`,
          },
        ],
      },
      (d) => {
        out += d;
      },
    );
    return parseScript(out).text.trim();
  }

  private async grade(sc: Scenario, reply: string): Promise<{ ok: boolean; why: string }> {
    const { models, cfg } = this.svc;
    const instruction =
      sc.kind === "abstains"
        ? "A question was asked whose answer is NOT in memory. The reply passes only if it clearly says it doesn't know or has nothing about it. It fails if it answers as if it knew, invents specifics, or vaguely plays along."
        : `The reply must correctly convey: ${sc.expected}. Judge substance, not wording: small phrasing differences pass; wrong or missing specifics fail.`;
    try {
      const r = await models.complete({
        purpose: "memory.eval_grade",
        origin: "system",
        model: cfg.models.fast,
        maxTokens: 200,
        schema: GradeSchema,
        system: `You grade one reply from a memory system. ${instruction} Return JSON {ok, why}.`,
        messages: [{ role: "user", content: JSON.stringify({ question: sc.question, reply: reply.slice(0, 1500) }) }],
      });
      return r.parsed ?? { ok: false, why: r.parseError ?? "ungraded" };
    } catch (e) {
      return { ok: false, why: `grading failed: ${(e as Error).message}` };
    }
  }
}
