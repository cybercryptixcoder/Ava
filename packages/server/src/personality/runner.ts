import type Anthropic from "@anthropic-ai/sdk";
import { parseScript } from "@ava/shared";
import type { Services } from "../core/services";
import { js, newId, j } from "../db/db";
import { lengthGuidance } from "../conversation/conversation";
import { detectAffirmations } from "../conversation/affirmation";
import { parseReply } from "../conversation/directives";
import { STATE_OF_MIND } from "../validator/message-validator";

export interface CaseResult {
  id: string;
  title: string;
  mode: "async" | "live";
  input: string;
  reply: string;
  modules: string[];
  words: number;
  affirmations: string[];
  checks: { name: string; ok: boolean; detail: string }[];
  audio_id: string | null;
  ms: number;
}

export interface PersonalityRun {
  id: string;
  created_at: string;
  voice_hash: string;
  label: string | null;
  results: CaseResult[];
}

/**
 * The personality test set: sample conversations re-run whenever the voice
 * files change, compared side by side as text and as audio. The run uses the
 * same system prompt as real conversations, against a fixed context, and
 * never touches the real conversation history.
 */
export class PersonalityRunner {
  constructor(private svc: Services) {}

  status(): { voice_hash: string; last_run_hash: string | null; stale: boolean; cases: number } {
    const last = this.svc.db.get<{ voice_hash: string }>("SELECT voice_hash FROM personality_runs ORDER BY created_at DESC LIMIT 1");
    const hash = this.svc.personality.hash();
    return { voice_hash: hash, last_run_hash: last?.voice_hash ?? null, stale: last?.voice_hash !== hash, cases: this.svc.personality.testset().length };
  }

  runs(limit = 10): PersonalityRun[] {
    return this.svc.db
      .all<{ id: string; created_at: string; voice_hash: string; label: string | null; results: string }>("SELECT * FROM personality_runs ORDER BY created_at DESC LIMIT ?", [limit])
      .map((r) => ({ ...r, results: j<CaseResult[]>(r.results, []) }));
  }

  async run(opts: { label?: string; audio?: boolean } = {}): Promise<PersonalityRun> {
    const { personality, models, cfg, voice, conversation, settings, db, clock, log } = this.svc;
    const cases = personality.testset();
    const results: CaseResult[] = [];
    for (const c of cases) {
      const spoken = c.mode === "live";
      const userTurns = c.turns.filter((t) => t.role === "user");
      const last = userTurns[userTurns.length - 1]?.text ?? "";
      const history: Anthropic.MessageParam[] = [];
      for (const t of c.turns.slice(0, -1)) history.push({ role: t.role === "user" ? "user" : "assistant", content: t.text });
      const lg = lengthGuidance(last, spoken);
      const started = Date.now();
      const res = await models.complete({
        purpose: "personality.test",
        origin: "interactive",
        model: c.mode === "live" ? settings.get().voice.live_model : cfg.models.conversation,
        maxTokens: lg.maxTokens,
        lowLatency: c.mode === "live",
        effort: lg.kind === "quick" ? "low" : "medium",
        system: conversation.systemBlocks(spoken),
        messages: [
          ...history,
          {
            role: "user",
            content: `<context>\n${c.context ?? "Test conversation: no live life-model context."}\n\nThis reply will be ${spoken ? "spoken aloud while the screen shows detail" : "read on screen"}. ${lg.note}${c.mode === "live" ? "\nLive mode: a real-time spoken conversation. No fillers." : ""}\n</context>\n\n${last}`,
          },
        ],
      });
      const ms = Date.now() - started;
      const parsed = parseReply(res.text);
      const text = parseScript(parsed.text).text.trim();
      const words = text.split(/\s+/).filter(Boolean).length;
      const aff = detectAffirmations(text);
      const checks = [
        { name: "No bullet points or headers", ok: !/^\s*([-*•]|\d+\.|#{1,6})\s/m.test(text), detail: "" },
        { name: "No emoji", ok: !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text), detail: "" },
        { name: "No praise", ok: aff.length === 0, detail: aff.join(" | ") },
        { name: "No invented state of mind", ok: !STATE_OF_MIND.test(text) || c.id.includes("bad-news"), detail: STATE_OF_MIND.exec(text)?.[0] ?? "" },
        { name: "Doesn't end with a question by reflex", ok: lg.kind === "dump" || !text.trim().endsWith("?") || c.id.includes("dump"), detail: "" },
        {
          name: "Length fits the input",
          ok: lg.kind === "quick" ? words <= 45 : lg.kind === "dump" ? words <= 260 : c.mode === "live" ? words <= 120 : words <= 320,
          detail: `${words} words for a ${lg.kind} input`,
        },
        ...(c.expect ?? []).map((e) => ({ name: e, ok: true, detail: "judge by reading" })),
      ];
      let audio_id: string | null = null;
      if (opts.audio && voice.ttsAvailable(c.mode === "live" ? "live" : "async")) {
        try {
          audio_id = (await voice.renderAsync(parsed.text, { purpose: "personality.test", operational: false, mode: c.mode === "live" ? "live" : "async" }))?.audio_id ?? null;
        } catch (e) {
          log.warn("personality.audio", `No audio for ${c.id}: ${(e as Error).message}`);
        }
      }
      results.push({ id: c.id, title: c.title, mode: c.mode, input: last, reply: text, modules: parsed.directives.map((d) => d.kind), words, affirmations: aff, checks, audio_id, ms });
    }
    const run: PersonalityRun = { id: newId("prn"), created_at: clock.now().toISOString(), voice_hash: personality.hash(), label: opts.label ?? null, results };
    db.run("INSERT INTO personality_runs (id, created_at, voice_hash, label, results) VALUES (?, ?, ?, ?, ?)", [run.id, run.created_at, run.voice_hash, run.label, js(results)]);
    log.info("personality.run", `Personality test set ran: ${results.length} cases, ${results.reduce((n, r) => n + r.checks.filter((c) => !c.ok).length, 0)} failed checks`, { run_id: run.id });
    return run;
  }
}
