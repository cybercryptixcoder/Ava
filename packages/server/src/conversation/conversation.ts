import type Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import { ChangeSchema, parseScript, type Change, type HydratedModule, type TurnView } from "@ava/shared";
import type { Services } from "../core/services";
import { newId } from "../db/db";
import type { Entry } from "../state/memory";
import { renderPack, estTokens, type ContextPack } from "../memory/retriever";
import { STACK_PROTOCOL } from "./protocol";
import { DirectiveParser, type Directive } from "./directives";
import { enforceAffirmationBudget, splitSentences } from "./affirmation";

/**
 * The stored raw reply keeps Ava's canvas directives, which sit between the
 * spoken sentences. When the affirmation budget trims sentences from the
 * words, remove the same sentences from the raw text rather than replacing
 * the whole span (which would fail whenever a directive is interleaved).
 */
export function dropTrimmedSentences(raw: string, before: string, after: string): string {
  const kept = new Set(splitSentences(after));
  let out = raw;
  for (const s of splitSentences(before)) if (!kept.has(s)) out = out.replace(s, "");
  return out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
import { extract } from "./extraction";
import { z } from "zod";

export type TalkEvent =
  | { type: "turn"; turn: TurnView }
  | { type: "status"; state: "extracting" | "thinking" | "speaking" | "idle" }
  /** What he said was filed: how many things, and how many need him (each its own card). */
  | { type: "filed"; filed: number; needs_you: number }
  | { type: "text"; delta: string }
  | { type: "module"; module: HydratedModule }
  | { type: "module_error"; key: string | null; errors: string[] }
  | { type: "remove"; key: string }
  | { type: "replace_text"; text: string }
  | { type: "style_note"; text: string }
  | { type: "done"; turn: TurnView }
  | { type: "audio"; audio_id: string; cues: { target: string; at_ms: number }[]; duration_ms: number | null }
  | { type: "error"; message: string };

export type Sink = (e: TalkEvent) => void;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_module_state",
    description: "Fetch the full current contents of a module on the canvas by its key, when the one-line summary isn't enough.",
    input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false },
  },
];

const AffirmationCheck = z.object({ praise_sentence_indices: z.array(z.number().int()) });

/** "Forget what I said about X" (typed or spoken): returns X, or null. */
export function forgetIntent(text: string): string | null {
  const m = /^\s*(?:please\s+)?(?:forget|delete) (?:what i said(?: about)?|about)\s+(.{2,120}?)[.!?]*\s*$/i.exec(text);
  return m ? m[1].trim() : null;
}

export function lengthGuidance(userText: string, spoken: boolean): { note: string; maxTokens: number; kind: "quick" | "riff" | "dump" | "normal" } {
  const words = userText.trim().split(/\s+/).filter(Boolean).length;
  const asks = /\?|what do you think|thoughts\?|what if|how would|should i/i.test(userText);
  if (words <= 25 && !asks)
    return { kind: "quick", maxTokens: 700, note: "He fired off a quick update. Answer in a line, maybe two. If it changed something, the chips cover it; don't restate them." };
  if (words >= 220)
    return {
      kind: "dump",
      maxTokens: 3000,
      note: `He dumped a lot (${words} words). Pull out the threads that matter, put structure on the canvas, pick the single most interesting thread and go a little deeper on it, and ask at most one question. ${spoken ? "Keep the spoken part to a few short paragraphs." : "Keep it to a few short paragraphs."}`,
    };
  if (asks || /\b(idea|i think|i've been thinking|riff|what about)\b/i.test(userText))
    return { kind: "riff", maxTokens: 2500, note: "He's thinking out loud with you. Engage with the substance: build on it, find the interesting thread, push back where he's wrong. You can go longer here." };
  return { kind: "normal", maxTokens: 1500, note: "Match his length and energy." };
}

/**
 * Async conversation: he dictates (often at length), Ava extracts structured
 * changes as confirmation chips, thinks, and replies in words plus canvas
 * modules. Quality beats speed here.
 */
export class Conversation {
  constructor(private svc: Services) {}

  /** Conversation turns, backed by the raw log (entries of kind "turn"). */
  turns(convId: string, limit = 40): TurnView[] {
    return this.svc.memory
      .list({ kind: "turn", session: convId, limit, order: "desc" })
      .reverse()
      .map((e) => this.turnView(e));
  }

  private turnView(e: Entry): TurnView {
    return {
      id: e.id,
      role: e.role as "user" | "ava",
      mode: (e.meta.mode as "async" | "live") ?? "async",
      text: e.text,
      input_kind: (e.meta.input_kind as string) ?? null,
      created_at: e.recorded_at,
      audio_id: (e.meta.audio_id as string) ?? null,
      cues: (e.meta.cues as { target: string; at_ms: number }[]) ?? null,
      trimmed_affirmation: !!e.meta.trimmed,
      memory_used: (e.meta.memory_used as string[]) ?? null,
    };
  }

  /** Both sides of every conversation live in the raw log; this is the only writer. */
  saveTurn(t: { convId: string; role: "user" | "ava"; mode: "async" | "live"; text: string; raw?: string; input_kind?: string; operational?: boolean; affirmation?: boolean; trimmed?: boolean }): TurnView {
    const id = this.svc.memory.append({
      kind: "turn",
      source: t.mode === "live" ? "live" : "conversation",
      role: t.role,
      session_id: t.convId,
      text: t.text,
      raw: t.raw ?? null,
      meta: { mode: t.mode, input_kind: t.input_kind ?? null, operational: !!t.operational, affirmation: !!t.affirmation, trimmed: !!t.trimmed },
    });
    return this.turnView(this.svc.memory.get(id)!);
  }

  setTurnAudio(turnId: string, audioId: string, cues: { target: string; at_ms: number }[]): void {
    this.svc.memory.mergeMeta(turnId, { audio_id: audioId, cues });
  }

  // ---------------------------------------------------------------- style notes

  styleNotes(): { id: string; text: string; active: boolean; created_at: string }[] {
    return this.svc.db.all<{ id: string; text: string; active: number; created_at: string }>("SELECT * FROM style_notes ORDER BY created_at").map((r) => ({ ...r, active: !!r.active }));
  }

  addStyleNote(text: string, turnId: string | null): void {
    const now = this.svc.clock.now().toISOString();
    this.svc.db.run("INSERT INTO style_notes (id, text, source_turn_id, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)", [newId("sty"), text.trim(), turnId, now, now]);
    this.svc.log.info("style.note", `Style note captured: ${text.trim()}`);
  }

  editStyleNote(id: string, patch: { text?: string; active?: boolean }): void {
    const now = this.svc.clock.now().toISOString();
    const cur = this.svc.db.get<{ text: string; active: number }>("SELECT text, active FROM style_notes WHERE id = ?", [id]);
    if (!cur) throw new Error("No such style note");
    this.svc.db.run("UPDATE style_notes SET text = ?, active = ?, updated_at = ? WHERE id = ?", [patch.text ?? cur.text, patch.active === undefined ? cur.active : patch.active ? 1 : 0, now, id]);
  }

  removeStyleNote(id: string): void {
    this.svc.db.run("DELETE FROM style_notes WHERE id = ?", [id]);
  }

  // ---------------------------------------------------------------- prompts

  /**
   * The stable part of the conversational system prompt. Order matters for
   * caching: instructions first, the core as the cache breakpoint, so the
   * whole stable prefix earns the prompt-cache discount on every call.
   */
  async systemBlocks(spoken: boolean): Promise<{ text: string; cache?: boolean }[]> {
    const { personality, cfg } = this.svc;
    const core = await this.svc.core.ensure();
    const blocks: { text: string; cache?: boolean }[] = [
      { text: `${personality.voice()}\n\nThe person you talk with is ${cfg.ownerName}.`, cache: false },
      { text: `## Example exchanges\n${personality.examples()}`, cache: false },
      { text: STACK_PROTOCOL, cache: !spoken && !core },
    ];
    if (spoken) blocks.push({ text: `## Speaking\n${personality.spoken()}`, cache: !core });
    if (core) blocks.push({ text: `## The core\nWhat you durably know about him. It refreshes on its own; never restate it wholesale.\n${core}`, cache: true });
    return blocks;
  }

  /** Volatile per-turn context: the context pack, style notes, length guidance. */
  async contextBlock(convId: string, userText: string, spoken: boolean, extra: string[] = [], pack: ContextPack | null = null): Promise<string> {
    const notes = this.styleNotes().filter((n) => n.active);
    const lg = lengthGuidance(userText, spoken);
    const tz = this.svc.settings.tz();
    const now = DateTime.fromJSDate(this.svc.clock.now()).setZone(tz).toFormat("ccc yyyy-LL-dd HH:mm");
    const hasMemory = !!pack && !pack.skipped && !pack.empty;
    return [
      `<context>`,
      `Now: ${now} (${tz}).`,
      renderPack(pack),
      hasMemory
        ? `Grounding: state past facts only as they appear in <memory> above; where it doesn't cover something, say so plainly instead of guessing.`
        : `Grounding: <memory> is empty for this message — if he asks about the past, say plainly you don't remember rather than guessing.`,
      notes.length ? `His style notes (follow these):\n${notes.map((n) => `- ${n.text}`).join("\n")}` : "",
      `This reply will be ${spoken ? "spoken aloud, with a short text version on screen" : "read on screen"}. ${lg.note}`,
      ...extra,
      `</context>`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** Prior turns as model messages, with directives summarized so the model remembers what it showed. */
  history(convId: string, limit = 12): Anthropic.MessageParam[] {
    const rows = this.svc.memory.list({ kind: "turn", session: convId, limit, order: "desc" }).reverse();
    const out: Anthropic.MessageParam[] = [];
    for (const r of rows) {
      const role = r.role === "user" ? "user" : "assistant";
      let text = r.raw ?? r.text;
      if (role === "assistant") text = text.replace(/<show>([\s\S]*?)<\/show>/g, (_m, body) => `[showed ${/"type"\s*:\s*"([a-z_]+)"/.exec(body)?.[1] ?? "module"} ${/"key"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? ""}]`);
      if (!text.trim()) continue;
      const last = out[out.length - 1];
      if (last && last.role === role) last.content = `${last.content as string}\n\n${text}`;
      else out.push({ role, content: text });
    }
    while (out.length && out[0].role !== "user") out.shift();
    return out;
  }

  /** The recent window: the last turns, verbatim, capped by count then tokens. */
  window(convId: string, dropNewest = 1): Anthropic.MessageParam[] {
    const s = this.svc.settings.get().memory;
    const msgs = this.history(convId, s.recent_turns + dropNewest);
    for (let i = 0; i < dropNewest && msgs.length; i++) msgs.pop();
    let tokens = 0;
    const out: Anthropic.MessageParam[] = [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const t = estTokens(String(msgs[i].content));
      if (out.length && tokens + t > s.recent_budget_tokens) break;
      tokens += t;
      out.unshift(msgs[i]);
    }
    return out;
  }

  // ---------------------------------------------------------------- directives

  handleDirective(convId: string, d: Directive, sink: Sink, turnRef: { id: string | null }): void {
    const { canvas, proposals, filing, log } = this.svc;
    try {
      if (d.kind === "show") {
        const r = canvas.show(convId, JSON.parse(d.body), "ava");
        if (r.ok) sink({ type: "module", module: r.module });
        else sink({ type: "module_error", key: null, errors: r.errors });
      } else if (d.kind === "update") {
        const r = canvas.update(convId, d.key, JSON.parse(d.body), "ava");
        if (r.ok) sink({ type: "module", module: r.module });
        else sink({ type: "module_error", key: d.key, errors: r.errors });
      } else if (d.kind === "remove") {
        canvas.remove(convId, d.key);
        sink({ type: "remove", key: d.key });
      } else if (d.kind === "propose") {
        const raw = JSON.parse(d.body);
        const list = (Array.isArray(raw) ? raw : [raw]) as unknown[];
        const entries = list
          .map((c) => ChangeSchema.safeParse(c))
          .filter((r): r is { success: true; data: Change } => r.success)
          .map((r) => ({ change: r.data }));
        if (!entries.length) {
          log.warn("canvas.invalid", "Ava proposed changes that failed validation", { body: d.body });
          return;
        }
        // Ava's own suggestions weren't said outright: each one asks him first, as a card.
        const f = filing.file(
          entries.map((e) => ({ change: e.change, summary: proposals.describe(e.change), reason: "Ava suggested this", stated: false })),
          { origin: "conversation", evidence_id: null },
        );
        sink({ type: "filed", filed: f.filed.length, needs_you: f.needs_you.length });
      } else if (d.kind === "style_note") {
        this.addStyleNote(d.body, turnRef.id);
        sink({ type: "style_note", text: d.body });
      }
    } catch (e) {
      log.warn("canvas.invalid", `A ${d.kind} block could not be parsed: ${(e as Error).message}`, { body: (d as { body?: string }).body });
      sink({ type: "module_error", key: null, errors: [(e as Error).message] });
    }
  }

  /** Count affirmations in the last N assistant replies (for the budget). */
  recentAffirmations(window: number): number {
    return this.svc.memory.list({ kind: "turn", role: "ava", limit: window, order: "desc" }).reduce((n, e) => n + (e.meta.affirmation ? 1 : 0), 0);
  }

  /** Model-based check for subtler praise the patterns miss (async mode only). */
  private async modelPraiseCheck(text: string): Promise<number[]> {
    const { models, cfg } = this.svc;
    const sentences = splitSentences(text);
    if (sentences.length === 0) return [];
    try {
      const r = await models.complete({
        purpose: "affirmation.check",
        origin: "interactive",
        model: cfg.models.fast,
        maxTokens: 200,
        schema: AffirmationCheck,
        system: "You flag praise, compliments, affirmations or encouragement directed at the listener (e.g. 'great question', 'smart move', 'you're doing well', 'love this idea'). Agreement on substance ('you're right that X') and plain acknowledgement of a fact are not praise. Return the indices of sentences that are praise.",
        messages: [{ role: "user", content: sentences.map((s, i) => `${i}: ${s}`).join("\n") }],
      });
      return r.parsed?.praise_sentence_indices.filter((i) => i >= 0 && i < sentences.length) ?? [];
    } catch {
      return [];
    }
  }

  /** Apply the affirmation budget to a finished reply's words. */
  async enforceBudget(text: string, opts: { useModel: boolean; operational: boolean }): Promise<{ text: string; affirmation: boolean; trimmed: boolean; regenerate: boolean }> {
    const s = this.svc.settings.get().conversation;
    const plain = parseScript(text).text;
    const extra = opts.useModel && s.affirmation_model_check ? await this.modelPraiseCheck(plain) : [];
    const decision = enforceAffirmationBudget(text, {
      recentCount: this.recentAffirmations(s.affirmation_window),
      max: s.affirmation_max,
      operational: opts.operational,
      completionAck: false,
      extraSentences: extra,
    });
    if (decision.found.length) {
      this.svc.log.info(
        "affirmation.check",
        decision.action === "keep" ? `Kept one affirmation within budget: "${decision.found[0]}"` : `Affirmation over budget (${decision.found.join(" | ")}); ${decision.action}`,
        { found: decision.found, action: decision.action },
      );
    }
    return { text: decision.text, affirmation: decision.found.length > 0 && decision.action === "keep", trimmed: decision.action === "trim", regenerate: decision.action === "regenerate" };
  }

  // ---------------------------------------------------------------- the async turn

  async send(input: { text: string; input_kind: string; conversation_id?: string; speak?: boolean }, sink: Sink, signal?: AbortSignal): Promise<void> {
    const svc = this.svc;
    const { canvas, evidence, proposals, models, cfg, settings, log } = svc;
    const convId = input.conversation_id ?? canvas.current();
    const text = input.text.trim();
    if (!text) throw new Error("Say or type something first");
    const userTurn = this.saveTurn({ convId, role: "user", mode: "async", text, input_kind: input.input_kind });
    sink({ type: "turn", turn: userTurn });
    // "Forget what I said about X" by voice: find it, confirm on a card, delete only on yes.
    const forgetQuery = forgetIntent(text);
    if (forgetQuery) {
      sink({ type: "status", state: "thinking" });
      let answer: string;
      const ids = svc.forgetFlow.resolve({ query: forgetQuery }).filter((id) => id !== userTurn.id);
      if (ids.length) {
        const closure = svc.forgetFlow.preview(ids);
        svc.cards.forForget(closure, forgetQuery);
        answer = `I found ${closure.entries.length} raw ${closure.entries.length === 1 ? "entry" : "entries"} in what you said about that, and put a confirmation on your stack. Nothing is gone until you answer it.`;
      } else {
        answer = `I looked, and there's nothing about "${forgetQuery}" in memory to forget.`;
      }
      const avaTurn = this.saveTurn({ convId, role: "ava", mode: "async", text: answer });
      sink({ type: "done", turn: avaTurn });
      sink({ type: "status", state: "idle" });
      return;
    }
    const evId = evidence.add({ kind: "transcript", source: "voice", content: { entry_id: userTurn.id }, summary: text.slice(0, 280), source_ref: userTurn.id });

    // 1. Extraction first (Haiku): what he stated is filed now, with undo; what's ambiguous becomes a card.
    let chipsLine = "";
    if (models.available) {
      sink({ type: "status", state: "extracting" });
      try {
        const changes = await extract(svc, text, { purpose: "conversation.extract", origin: "interactive", signal });
        if (changes.length) {
          const f = svc.filing.file(changes, { origin: "conversation", evidence_id: evId });
          sink({ type: "filed", filed: f.filed.length, needs_you: f.needs_you.length });
          chipsLine = `From what he just said, filed: ${f.filed.map((p) => p.summary).join("; ") || "nothing"}. Each of these needs his answer and is now a card: ${f.needs_you.map((p) => p.summary).join("; ") || "none"}. Don't restate them; at most say how many and that they're in his stack.`;
        }
      } catch (e) {
        log.warn("extraction.failed", `Extraction failed: ${(e as Error).message}`);
      }
    }

    // 2. The reply (Sonnet, streaming).
    const spoken = input.speak ?? settings.get().voice.autoplay;
    sink({ type: "status", state: "thinking" });
    const lg = lengthGuidance(text, spoken);
    // The read path: retrieval for this message. The pack is volatile context;
    // the recent window stays verbatim; both sit under the stable, cached prefix.
    const packStart = Date.now();
    let pack: ContextPack | null = null;
    try {
      pack = await svc.retriever.retrieve(text, { budgetTokens: settings.get().memory.context_budget_tokens });
    } catch (e) {
      log.warn("memory.retrieve", `Retrieval failed; answering without a pack: ${(e as Error).message}`);
    }
    const retrievalMs = Date.now() - packStart;
    const window = this.window(convId);
    const system = await this.systemBlocks(spoken);
    const turnRef = { id: null as string | null };
    let raw = "";
    const run = async (extraNote?: string) => {
      raw = "";
      const parser = new DirectiveParser(
        (t) => sink({ type: "text", delta: t }),
        (d) => this.handleDirective(convId, d, sink, turnRef),
      );
      const messages: Anthropic.MessageParam[] = [
        ...window,
        { role: "user", content: `${await this.contextBlock(convId, text, spoken, [chipsLine, extraNote ?? ""].filter(Boolean), pack)}\n\n${text}` },
      ];
      for (let round = 0; round < 3; round++) {
        const res = await models.stream(
          {
            purpose: "conversation.reply",
            origin: "interactive",
            model: cfg.models.conversation,
            maxTokens: lg.maxTokens,
            effort: lg.kind === "quick" ? "low" : "medium",
            system,
            messages,
            tools: TOOLS,
            signal,
          },
          (d) => {
            raw += d;
            parser.push(d);
          },
        );
        if (res.stopReason !== "tool_use" || !res.toolUses.length) break;
        messages.push({ role: "assistant", content: res.message.content as Anthropic.ContentBlockParam[] });
        messages.push({
          role: "user",
          content: res.toolUses.map((t) => {
            const key = (t.input as { key?: string }).key ?? "";
            const m = canvas.get(convId, key);
            return { type: "tool_result" as const, tool_use_id: t.id, content: m ? JSON.stringify(m.data) : `No module "${key}" on the canvas`, is_error: !m };
          }),
        });
      }
      parser.end();
      return parser.text;
    };

    let words = await run();
    let check = await this.enforceBudget(words, { useModel: true, operational: false });
    if (check.regenerate) {
      sink({ type: "replace_text", text: "" });
      words = await run("Do not include praise or compliments in this reply.");
      check = await this.enforceBudget(words, { useModel: false, operational: false });
    }
    const finalWords = check.text;
    const display = parseScript(finalWords).text.trim();
    if (finalWords !== words) sink({ type: "replace_text", text: display });
    const avaTurn = this.saveTurn({ convId, role: "ava", mode: "async", text: display, raw: finalWords === words ? raw : dropTrimmedSentences(raw, words, finalWords), affirmation: check.affirmation, trimmed: check.trimmed });
    turnRef.id = avaTurn.id;
    // Grounding: which refs the reply drew on, and what the call carried per segment.
    const usedIds = pack?.entries_used ?? [];
    if (usedIds.length) svc.memory.mergeMeta(avaTurn.id, { memory_used: usedIds.slice(0, 30) });
    const winTokens = window.reduce((n, m) => n + estTokens(String(m.content)), 0);
    const prefixTokens = system.reduce((n, b) => n + estTokens(b.text), 0);
    log.info(
      "memory.grounding",
      `Context for this reply: ~${prefixTokens} prefix, ${pack?.tokens ?? 0} pack, ${winTokens} window, ${estTokens(text)} message tokens; retrieval ${retrievalMs} ms${usedIds.length ? `; drew on ${usedIds.length} ${usedIds.length === 1 ? "entry" : "entries"}` : "; no memory refs"}`,
      { turn_id: avaTurn.id, refs: usedIds.slice(0, 30), prefix_tokens: prefixTokens, pack_tokens: pack?.tokens ?? 0, window_tokens: winTokens, message_tokens: estTokens(text), retrieval_ms: retrievalMs, via: pack?.via ?? null },
    );
    sink({ type: "done", turn: avaTurn });
    sink({ type: "status", state: "idle" });

    // 3. Speak it (word timestamps drive the reveal of canvas segments).
    if (spoken && svc.voice.ttsAvailable("async") && display) {
      try {
        sink({ type: "status", state: "speaking" });
        const audio = await svc.voice.renderAsync(finalWords, { purpose: "reply", operational: false });
        if (audio) {
          this.setTurnAudio(avaTurn.id, audio.audio_id, audio.cues);
          sink({ type: "audio", audio_id: audio.audio_id, cues: audio.cues, duration_ms: audio.duration_ms });
        }
      } catch (e) {
        log.warn("tts.failed", `Couldn't speak the reply: ${(e as Error).message}`);
        sink({ type: "error", message: `Spoken reply unavailable: ${(e as Error).message}` });
      } finally {
        sink({ type: "status", state: "idle" });
      }
    }
  }
}
