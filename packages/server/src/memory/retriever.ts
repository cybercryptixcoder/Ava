import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import type { Services } from "../core/services";
import type { Hit, RefKind } from "./search";

/**
 * The read path's front door: given a message, assemble a small context pack
 * under a token budget. Candidates come from the keyword index (embeddings
 * merge in later); ranking mixes relevance, recency (exponential decay) and
 * importance with configurable weights. The retriever can run as a cheap
 * sub-agent in its own clean context with search/read/expand tools — the
 * conversation model never sees the digging, only the pack. With no model
 * key (or a failure), a deterministic direct pass assembles the same shape.
 *
 * The pack never invents: gists and facts cite raw entry ids, verbatim
 * excerpts carry their ids and timestamps, and an empty result says so
 * plainly so the conversation can answer "I don't remember" honestly.
 */

export interface PackGist {
  id: string;
  gist: string;
  at: string;
}
export interface PackFact {
  id: string;
  statement: string;
  valid_from: string | null;
  valid_to: string | null;
  superseded_by: string | null;
  at: string;
}
export interface PackExcerpt {
  id: string;
  kind: string;
  text: string;
  at: string;
}
export interface ContextPack {
  empty: boolean;
  skipped: boolean;
  via: "agent" | "direct";
  gists: PackGist[];
  facts: PackFact[];
  excerpts: PackExcerpt[];
  entries_used: string[];
  tokens: number;
}

const estTokens = (s: string) => Math.ceil(s.length / 4);

const ACK = /^(ok(ay)?|k|thanks|thank you|ty|cool|nice|got it|sure|yep?|nope?|no|lol|haha+|done|great|perfect|alright|right|hm+|mm+)[.!\s]*$/i;

/** Messages that clearly need no memory at all (the fast path). */
export function isTrivial(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 40) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 4) return false;
  if (/\?$/.test(t)) return false;
  return words.every((w) => ACK.test(w) || ACK.test(t));
}

/** Pull a time range out of the query ("last month", "in September", "before midterms" as month names only). */
export function parseTimeRange(query: string, now: Date, tz: string): { since?: string; until?: string } {
  const q = query.toLowerCase();
  const local = DateTime.fromJSDate(now).setZone(tz);
  const iso = (d: DateTime): string => d.toUTC().toISO() ?? "";
  const months: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  if (/\btoday\b/.test(q)) return { since: iso(local.startOf("day")), until: iso(local.plus({ days: 1 }).startOf("day")) };
  if (/\byesterday\b/.test(q)) return { since: iso(local.minus({ days: 1 }).startOf("day")), until: iso(local.startOf("day")) };
  if (/\b(this|last)\s+week\b/.test(q)) {
    const start = /\blast\b/.test(q) ? local.minus({ weeks: 1 }).startOf("week") : local.startOf("week");
    const end = /\blast\b/.test(q) ? local.startOf("week") : local.plus({ weeks: 1 }).startOf("week");
    return { since: iso(start), until: iso(end) };
  }
  if (/\b(this|last)\s+month\b/.test(q)) {
    const start = /\blast\b/.test(q) ? local.minus({ months: 1 }).startOf("month") : local.startOf("month");
    const end = /\blast\b/.test(q) ? local.startOf("month") : local.plus({ months: 1 }).startOf("month");
    return { since: iso(start), until: iso(end) };
  }
  const m = /\b(?:in|d[ur]ing|around|before|after|since)\s+([a-z]+)\b/.exec(q);
  if (m && months[m[1]]) {
    const month = months[m[1]];
    const year = month > local.month ? local.year - 1 : local.year;
    const start = DateTime.fromObject({ year, month, day: 1 }, { zone: tz });
    const end = start.plus({ months: 1 });
    if (/\bbefore\b/.test(q)) return { until: iso(start) };
    if (/\bafter\b|\bsince\b/.test(q)) return { since: iso(start) };
    return { since: iso(start), until: iso(end) };
  }
  return {};
}

const HISTORY = /\b(before|used to|previously|was |were |changed|moved|earlier|originally|history)\b/i;

/** The retriever itself, plus the direct composition it falls back to. */
export class Retriever {
  constructor(private svc: Services) {}

  async retrieve(query: string, opts: { budgetTokens?: number } = {}): Promise<ContextPack> {
    const s = this.svc.settings.get().memory;
    const budget = opts.budgetTokens ?? s.context_budget_tokens;
    if (s.fast_path && isTrivial(query)) return { empty: false, skipped: true, via: "direct", gists: [], facts: [], excerpts: [], entries_used: [], tokens: 0 };
    const tz = this.svc.settings.tz();
    const range = parseTimeRange(query, this.svc.clock.now(), tz);
    if (s.retriever.mode === "agent" && this.svc.models.available) {
      try {
        const pack = await this.agent(query, range, budget);
        if (pack) return pack;
      } catch (e) {
        this.svc.log.warn("memory.retrieve", `The retriever agent fell back to the direct pass: ${(e as Error).message}`);
      }
    }
    return await this.direct(query, range, budget);
  }

  /**
   * Candidates for the pack: keyword hits merged with semantic neighbors.
   * Relevance is keyword score (normalized) plus semantic similarity, then
   * weighted with recency and importance per the memory.ranking settings.
   */
  private async candidates(query: string, range: { since?: string; until?: string }): Promise<{ hit: Hit; final: number }[]> {
    const s = this.svc.settings.get().memory;
    const kws = this.svc.memorySearch.search(query, { since: range.since, until: range.until, limit: 60 });
    const max = kws.reduce((m, h) => Math.max(m, h.score), 0) || 1;
    const byKey = new Map<string, { hit: Hit; kwNorm: number; cos: number }>();
    for (const h of kws) byKey.set(`${h.ref_kind}:${h.ref_id}`, { hit: h, kwNorm: h.score / max, cos: 0 });
    try {
      for (const near of await this.svc.embeddings.nearest(query)) {
        const key = `${near.ref_kind}:${near.ref_id}`;
        const cur = byKey.get(key);
        if (cur) {
          cur.cos = near.cos;
          continue;
        }
        const meta = this.refMeta(near.ref_kind, near.ref_id);
        if (!meta) continue; // forgotten or gone
        if (range.since && meta.at < range.since) continue;
        if (range.until && meta.at >= range.until) continue;
        byKey.set(key, { hit: { ref_kind: near.ref_kind, ref_id: near.ref_id, score: 0, at: meta.at, importance: meta.importance }, kwNorm: 0, cos: near.cos });
      }
    } catch (e) {
      this.svc.log.warn("memory.retrieve", `Semantic neighbors skipped: ${(e as Error).message}`);
    }
    const wSem = s.ranking.semantic;
    const now = this.svc.clock.now().getTime();
    return [...byKey.values()]
      .map((c) => {
        const relevance = (c.kwNorm + wSem * c.cos) / (1 + wSem);
        const ageDays = Math.max(0, (now - Date.parse(c.hit.at)) / 86_400_000);
        const recency = Math.exp(-ageDays / s.ranking.half_life_days);
        const final = s.ranking.relevance * relevance + s.ranking.recency * recency + s.ranking.importance * c.hit.importance;
        return { hit: c.hit, final };
      })
      .sort((a, b) => b.final - a.final);
  }

  /** When and how important a ref is, for semantic-only candidates. */
  private refMeta(kind: RefKind, id: string): { at: string; importance: number } | null {
    const { db } = this.svc;
    if (kind === "entry") {
      const r = db.get<{ occurred_at: string; deleted_at: string | null }>("SELECT occurred_at, deleted_at FROM entries WHERE id = ?", [id]);
      return r && !r.deleted_at ? { at: r.occurred_at, importance: 0.5 } : null;
    }
    if (kind === "episode") {
      const r = db.get<{ start_at: string; importance: number }>("SELECT start_at, importance FROM episodes WHERE id = ?", [id]);
      return r ? { at: r.start_at, importance: Number(r.importance) } : null;
    }
    const r = db.get<{ recorded_at: string; importance: number }>("SELECT recorded_at, importance FROM facts WHERE id = ? AND status != 'removed'", [id]);
    return r ? { at: r.recorded_at, importance: Number(r.importance) } : null;
  }

  /** The direct pass: compose the pack from ranked candidates without a model. */
  async direct(query: string, range: { since?: string; until?: string }, budget: number): Promise<ContextPack> {
    const ranked = await this.candidates(query, range);
    const gists: PackGist[] = [];
    const facts: PackFact[] = [];
    const excerpts: PackExcerpt[] = [];
    const used = new Set<string>();
    let tokens = 0;
    const seen = new Set<string>();
    for (const { hit } of ranked) {
      const key = `${hit.ref_kind}:${hit.ref_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (hit.ref_kind === "episode" && gists.length < 6) {
        const g = this.episode(hit.ref_id);
        if (!g) continue;
        const cost = estTokens(g.gist) + 8;
        if (tokens + cost > budget) continue;
        gists.push(g);
        tokens += cost;
      } else if (hit.ref_kind === "fact" && facts.length < 10) {
        const f = this.fact(hit.ref_id);
        if (!f) continue;
        const history = HISTORY.test(query);
        const superseded = !!f.valid_to || !!f.superseded_by;
        if (superseded && !history) continue; // current view unless the question is about change
        const cost = estTokens(f.statement) + 14;
        if (tokens + cost > budget) continue;
        facts.push(f);
        tokens += cost;
        for (const src of this.factSources(hit.ref_id).slice(0, 1)) {
          if (excerpts.length >= 6) break;
          const ex = this.excerpt(src);
          if (!ex || seen.has(`entry:${ex.id}`)) continue;
          const c = estTokens(ex.text) + 10;
          if (tokens + c > budget) break;
          seen.add(`entry:${ex.id}`);
          excerpts.push(ex);
          used.add(ex.id);
          tokens += c;
        }
      } else if (hit.ref_kind === "entry" && excerpts.length < 6) {
        const ex = this.excerpt(hit.ref_id);
        if (!ex) continue;
        const cost = estTokens(ex.text) + 10;
        if (tokens + cost > budget) continue;
        excerpts.push(ex);
        used.add(ex.id);
        tokens += cost;
      }
    }
    return { empty: !gists.length && !facts.length && !excerpts.length, skipped: false, via: "direct", gists, facts, excerpts, entries_used: [...used], tokens };
  }

  // -------------------------------------------------------------- the agent

  async agent(query: string, range: { since?: string; until?: string }, budget: number): Promise<ContextPack | null> {
    const s = this.svc.settings.get().memory;
    const cfg = this.svc.cfg;
    const tz = this.svc.settings.tz();
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: `Message to gather context for: ${query}\nToday: ${DateTime.fromJSDate(this.svc.clock.now()).setZone(tz).toFormat("ccc yyyy-LL-dd HH:mm")} (${tz}).` },
    ];
    const StepSchema = z.object({
      done: z.boolean().default(false),
      tool: z.enum(["search", "read", "expand"]).nullable().default(null),
      query: z.string().max(300).nullable().default(null),
      ref_id: z.string().max(60).nullable().default(null),
      selected: z.array(z.string().max(60)).max(14).default([]),
      note: z.string().max(200).nullable().default(null),
    });
    const system =
      "You pack memory context for another model. You have tools: search(query, kinds gist|fact|entry, since, until) → candidates; read(ref_id) → verbatim text or statement; expand(ref_id) → one hop of linked refs (refs look like epi_…, fct_…, ent_…).\n" +
      "Goal: the smallest set of ref ids that answers the message. Prefer gists (epi_) to route, facts (fct_) for what's known, raw entries (ent_) when exact wording, names, numbers or quotes matter, and older items when the question is about change over time.\n" +
      "Reply with JSON only: a tool call {\"tool\":\"search\",\"query\":\"…\"} or the end {\"done\":true,\"selected\":[\"fct_…\",\"ent_…\"]}. If nothing relevant exists, end empty with note \"nothing relevant\".";
    for (let round = 0; round < s.retriever.max_rounds; round++) {
      const r = await this.svc.models.complete({
        purpose: "memory.retrieve",
        origin: "system",
        model: cfg.models.fast,
        maxTokens: 700,
        lowLatency: true,
        schema: StepSchema,
        system,
        messages,
      });
      const step = r?.parsed;
      if (!step) throw new Error(r?.parseError ?? "The retriever agent returned nothing");
      if (step.done) return this.compose(step.selected, budget);
      let result: unknown = { error: "no tool call" };
      if (step.tool === "search") result = await this.toolSearch(step.query ?? query, range);
      else if (step.tool === "read" && step.ref_id) result = this.toolRead(step.ref_id);
      else if (step.tool === "expand" && step.ref_id) result = this.toolExpand(step.ref_id);
      messages.push({ role: "assistant", content: JSON.stringify(step) });
      messages.push({ role: "user", content: `Tool result:\n${JSON.stringify(result).slice(0, 4000)}` });
    }
    return null; // rounds exhausted: the direct pass takes over
  }

  private async toolSearch(query: string, range: { since?: string; until?: string }): Promise<{ hits: { ref: string; kind: string; at: string; preview: string }[] }> {
    const cands = await this.candidates(query, range);
    return {
      hits: cands.slice(0, 10).map((c) => ({ ref: c.hit.ref_id, kind: c.hit.ref_kind, at: c.hit.at.slice(0, 10), preview: this.preview(c.hit).slice(0, 160) })),
    };
  }

  private toolRead(refId: string): unknown {
    const kind = refId.slice(0, 3);
    if (kind === "ent") {
      const e = this.svc.memory.get(refId);
      return e ? { ref: refId, kind: "entry", at: e.occurred_at, text: e.text.slice(0, 1500) } : { error: "not found" };
    }
    if (kind === "epi") {
      const g = this.episode(refId);
      return g ? { ref: refId, kind: "episode", at: g.at, gist: g.gist, covered: this.svc.memory.episodeEntries(refId).slice(0, 8).map((id) => ({ ref: id, preview: (this.svc.memory.get(id)?.text ?? "").slice(0, 100) })) } : { error: "not found" };
    }
    if (kind === "fct") {
      const f = this.fact(refId);
      return f ? { ref: refId, kind: "fact", at: f.at, statement: f.statement, valid_from: f.valid_from, valid_to: f.valid_to, sources: this.factSources(refId).slice(0, 6) } : { error: "not found" };
    }
    return { error: "unknown ref" };
  }

  private toolExpand(refId: string): unknown {
    const kind = refId.slice(0, 3);
    if (kind === "ent") {
      const links = this.svc.memory.linksOf(refId).slice(0, 10);
      const back = this.svc.memory.linksTo("entry", refId).slice(0, 10);
      const episodes = this.svc.db.all<{ episode_id: string }>("SELECT episode_id FROM episode_entries WHERE entry_id = ? LIMIT 6", [refId]).map((r) => r.episode_id);
      return { ref: refId, links, linked_by: back, episodes };
    }
    if (kind === "epi") {
      const entries = this.svc.memory.episodeEntries(refId);
      return { ref: refId, entries: entries.slice(0, 10).map((id) => ({ ref: id, preview: (this.svc.memory.get(id)?.text ?? "").slice(0, 120) })) };
    }
    if (kind === "fct") return { ref: refId, sources: this.factSources(refId) };
    return { error: "unknown ref" };
  }

  // ------------------------------------------------------------- composing

  /** Build a pack from the agent's chosen ref ids, under the budget. */
  compose(selected: string[], budget: number): ContextPack {
    const gists: PackGist[] = [];
    const facts: PackFact[] = [];
    const excerpts: PackExcerpt[] = [];
    const used = new Set<string>();
    let tokens = 0;
    for (const ref of selected) {
      const kind = ref.slice(0, 3);
      if (kind === "epi" && gists.length < 6) {
        const g = this.episode(ref);
        if (!g) continue;
        const c = estTokens(g.gist) + 8;
        if (tokens + c > budget) continue;
        gists.push(g);
        tokens += c;
      } else if (kind === "fct" && facts.length < 10) {
        const f = this.fact(ref);
        if (!f) continue;
        const c = estTokens(f.statement) + 14;
        if (tokens + c > budget) continue;
        facts.push(f);
        tokens += c;
      } else if (kind === "ent" && excerpts.length < 8) {
        const ex = this.excerpt(ref);
        if (!ex) continue;
        const c = estTokens(ex.text) + 10;
        if (tokens + c > budget) continue;
        excerpts.push(ex);
        used.add(ex.id);
        tokens += c;
      }
    }
    return { empty: !gists.length && !facts.length && !excerpts.length, skipped: false, via: "agent", gists, facts, excerpts, entries_used: [...used], tokens };
  }

  private preview(h: Hit): string {
    if (h.ref_kind === "episode") return this.episode(h.ref_id)?.gist ?? "";
    if (h.ref_kind === "fact") return this.fact(h.ref_id)?.statement ?? "";
    return this.svc.memory.get(h.ref_id)?.text ?? "";
  }

  private episode(id: string): PackGist | null {
    const r = this.svc.db.get<{ gist_enc: string | null; start_at: string }>("SELECT gist_enc, start_at FROM episodes WHERE id = ?", [id]);
    if (!r) return null;
    return { id, gist: this.svc.cipher.decOpt(r.gist_enc as string) ?? "(no gist yet)", at: r.start_at };
  }

  private fact(id: string): PackFact | null {
    const r = this.svc.db.get<Record<string, unknown>>("SELECT * FROM facts WHERE id = ? AND status != 'removed'", [id]);
    if (!r) return null;
    return {
      id,
      statement: this.svc.cipher.decOpt(r.statement_enc as string) ?? "",
      valid_from: (r.valid_from as string) ?? null,
      valid_to: (r.valid_to as string) ?? null,
      superseded_by: (r.superseded_by as string) ?? null,
      at: String(r.recorded_at),
    };
  }

  private factSources(factId: string): string[] {
    return this.svc.db.all<{ entry_id: string }>("SELECT entry_id FROM fact_entries WHERE fact_id = ?", [factId]).map((r) => r.entry_id);
  }

  private excerpt(entryId: string): PackExcerpt | null {
    const e = this.svc.memory.get(entryId);
    if (!e || e.deleted_at) return null;
    return { id: e.id, kind: e.kind, text: e.text.slice(0, 700), at: e.occurred_at };
  }
}
