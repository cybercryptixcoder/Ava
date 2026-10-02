import {
  atLocal,
  formatClock,
  inQuietHours,
  localDateKey,
  nextWakingInstant,
  stripTokens,
  type CardKind,
  type CardLayer2,
  type CardLayer3,
  type CardOption,
  type CardResponse,
  type CardResult,
  type CardView,
  type FiledEntry,
  type HydratedItem,
  type Item,
  type MessageView,
  type Proposal,
  type QuestionView,
  type StackView,
} from "@ava/shared";
import { DateTime } from "luxon";
import type { Services } from "../core/services";
import { j, js, newId } from "../db/db";

/** What "yes" (or a specific option) does. Stored with the card, never sent to the app. */
type Act =
  | { t: "message"; option_key: string }
  | { t: "rule"; approve: boolean }
  | { t: "belief"; confirm: boolean }
  | { t: "proposal"; accept: boolean }
  | { t: "answer"; text: string }
  | { t: "open_action" }
  | { t: "open_artifact" }
  | { t: "ack" };

interface StoredOption extends CardOption {
  act: Act;
}

export type CardSource = "message" | "rule" | "belief" | "proposal" | "question" | "filing" | "artifact" | "action" | "review";

interface Card {
  id: string;
  kind: CardKind;
  source: CardSource;
  ref_id: string | null;
  thread_id: string | null;
  item_ids: string[];
  title: string;
  why: string | null;
  options: StoredOption[];
  data: Record<string, unknown>;
  priority: number;
  time_sensitive: boolean;
  status: "active" | "snoozed" | "done" | "dismissed" | "expired";
  visible_from: string;
  snoozed_until: string | null;
  expires_at: string | null;
  returns: number;
  pushed_at: string | null;
  created_at: string;
}

interface NewCard {
  kind: CardKind;
  source: CardSource;
  ref_id: string | null;
  item_ids?: string[];
  title: string;
  why: string | null;
  options: StoredOption[];
  data?: Record<string, unknown>;
  priority: number;
  time_sensitive?: boolean;
  visible_from?: Date;
  expires_at?: Date | null;
}

function rowToCard(r: Record<string, unknown>): Card {
  return {
    id: String(r.id),
    kind: r.kind as CardKind,
    source: r.source as CardSource,
    ref_id: (r.ref_id as string) ?? null,
    thread_id: (r.thread_id as string) ?? null,
    item_ids: j(r.item_ids, []),
    title: String(r.title),
    why: (r.why as string) ?? null,
    options: j(r.options, []),
    data: j(r.data, {}),
    priority: Number(r.priority),
    time_sensitive: !!r.time_sensitive,
    status: r.status as Card["status"],
    visible_from: String(r.visible_from),
    snoozed_until: (r.snoozed_until as string) ?? null,
    expires_at: (r.expires_at as string) ?? null,
    returns: Number(r.returns),
    pushed_at: (r.pushed_at as string) ?? null,
    created_at: String(r.created_at),
  };
}

const opt = (key: string, label: string, act: Act, extra: { detail?: string | null; work?: boolean } = {}): StoredOption => ({ key, label, detail: extra.detail ?? null, work: extra.work ?? false, act });

/**
 * Cards: one thing that needs him, not one row from the database. Do (an
 * action), Pick (a decision between 2 to 4 options) or Know (a heads-up).
 * Layer 1 is stored; layers 2 and 3 are built from current state only when
 * he opens them. The stack is short, ordered by Ava, and finite.
 *
 * Proactive messages still go through the rules, the validator and the
 * dispatcher's caps unchanged; a message that passes becomes a card here.
 */
export class CardStore {
  constructor(private svc: Services) {}

  private now(): Date {
    return this.svc.clock.now();
  }

  get(id: string): Card | null {
    const r = this.svc.db.get("SELECT * FROM cards WHERE id = ?", [id]);
    return r ? rowToCard(r) : null;
  }

  private openByRef(source: CardSource, refId: string): Card | null {
    const r = this.svc.db.get("SELECT * FROM cards WHERE source = ? AND ref_id = ? AND status IN ('active', 'snoozed') ORDER BY created_at DESC LIMIT 1", [source, refId]);
    return r ? rowToCard(r) : null;
  }

  private createdSince(source: CardSource, days: number): number {
    const since = new Date(this.now().getTime() - days * 86_400_000).toISOString();
    return this.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM cards WHERE source = ? AND created_at >= ?", [source, since])?.n ?? 0;
  }

  private coolingDown(key: string): boolean {
    return !!this.svc.db.get("SELECT key FROM cooldowns WHERE key = ? AND until > ?", [key, this.now().toISOString()]);
  }

  create(c: NewCard): Card {
    if (c.ref_id) {
      const existing = this.openByRef(c.source, c.ref_id);
      if (existing) return existing;
    }
    const { db, items, log, bus } = this.svc;
    const now = this.now().toISOString();
    const id = newId("crd");
    const thread_id = (c.item_ids ?? []).map((i) => items.get(i)?.thread_id).find((t) => !!t) ?? null;
    db.run(
      `INSERT INTO cards (id, kind, source, ref_id, thread_id, item_ids, title, why, options, data, priority, time_sensitive, status, visible_from, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      [
        id,
        c.kind,
        c.source,
        c.ref_id,
        thread_id,
        js(c.item_ids ?? []),
        c.title,
        c.why,
        js(c.options),
        js(c.data ?? {}),
        c.priority,
        c.time_sensitive ? 1 : 0,
        (c.visible_from ?? this.now()).toISOString(),
        c.expires_at ? c.expires_at.toISOString() : null,
        now,
        now,
      ],
    );
    log.info("card.created", `${c.kind === "do" ? "Do" : c.kind === "pick" ? "Pick" : "Know"} card: ${c.title}`, { card_id: id, source: c.source, ref_id: c.ref_id });
    bus.emit({ type: "state.changed", what: ["cards"] });
    return this.get(id)!;
  }

  view(c: Card): CardView {
    const t = c.thread_id ? this.svc.threads.get(c.thread_id) : null;
    return {
      id: c.id,
      kind: c.kind,
      title: c.title,
      why: c.why,
      thread: t ? { id: t.id, title: t.title } : null,
      options: c.options.map(({ act: _a, ...o }) => o),
      time_sensitive: c.time_sensitive,
      returns: c.returns,
      has_items: c.item_ids.length > 0,
      created_at: c.created_at,
    };
  }

  // -------------------------------------------------------------------------
  // Producers
  // -------------------------------------------------------------------------

  /** A message that passed the validator. `visibleFrom` is now if it was sent, the morning stack if it was queued. */
  fromMessage(m: MessageView, o: { visibleFrom: Date; priority: number; expiresAt?: Date | null }): Card {
    const substantive = m.options.filter((x) => x.action.kind === "start_executor" || x.action.kind === "reply" || (x.action.kind === "propose_change" && x.action.change.op !== "complete_item"));
    // Snoozes and "mark it done" are what "not now" and "already done" already do.
    const shown = m.options.filter((x, i) => i === 0 || (x.action.kind !== "snooze_item" && x.action.kind !== "none" && !(x.action.kind === "propose_change" && x.action.change.op === "complete_item")));
    return this.create({
      kind: substantive.length >= 2 ? "pick" : "do",
      source: "message",
      ref_id: m.id,
      item_ids: m.cited.map((c) => c.id),
      title: m.headline,
      why: m.because || null,
      options: shown.map((x) => opt(x.key, x.label, { t: "message", option_key: x.key }, { work: x.action.kind === "start_executor" })),
      data: { message_id: m.id, rule_id: m.rule_id },
      priority: o.priority,
      time_sensitive: m.urgency === "now",
      visible_from: o.visibleFrom,
      expires_at: o.expiresAt ?? null,
    });
  }

  /** Something from what he said that needs him before it's filed. */
  forProposal(p: Proposal, why: string): Card {
    const c = p.change;
    const itemIds = "item_id" in c && c.item_id ? [c.item_id] : [];
    return this.create({
      kind: "pick",
      source: "proposal",
      ref_id: p.id,
      item_ids: itemIds,
      title: `${p.summary}?`,
      why,
      options: [opt("file", "Yes, file it", { t: "proposal", accept: true }), opt("skip", "Leave it out", { t: "proposal", accept: false })],
      data: { quote: p.reason },
      priority: 60,
    });
  }

  /** After a brain dump: one card saying what was filed. */
  forFiling(batchId: string, filed: number, needsYou: number): Card {
    const words = (n: number) => (n === 1 ? "1 thing" : `${n} things`);
    return this.create({
      kind: "know",
      source: "filing",
      ref_id: batchId,
      title: needsYou ? `Filed ${words(filed)}, ${needsYou} need${needsYou === 1 ? "s" : ""} you` : `Filed ${words(filed)}`,
      why: "From what you just said. Open it to see them, with undo.",
      options: [opt("ok", "Got it", { t: "ack" })],
      data: { batch_id: batchId },
      // Above the cards for what needs him: first what happened, then what's left.
      priority: 65,
    });
  }

  /** A messaging rule that needs his yes; at most one such card per period. */
  forRuleApproval(ruleId: string): Card | null {
    const { rules, settings, log } = this.svc;
    const r = rules.view(ruleId);
    if (!r || r.status !== "proposed" || r.approval_tier === "auto") return null;
    const existing = this.openByRef("rule", ruleId);
    if (existing) return existing;
    const every = settings.get().stack.rule_card_every_days;
    if (this.createdSince("rule", every) > 0 || this.coolingDown("cards:rule")) {
      log.info("card.deferred", `Rule "${r.name}" waits in Rules; a rule card already came up in the last ${every} days`, { rule_id: ruleId });
      return null;
    }
    return this.create({
      kind: "pick",
      source: "rule",
      ref_id: ruleId,
      title: `Turn on "${r.name}"?`,
      why: r.evidence ?? r.readable,
      options: [opt("on", "Turn it on", { t: "rule", approve: true }, { detail: r.readable }), opt("off", "Not this one", { t: "rule", approve: false })],
      priority: 30,
    });
  }

  /** An unconfirmed inference, at most once per period, as a Pick. Never a list. */
  forBelief(): Card | null {
    const { beliefs, proposals, settings } = this.svc;
    if (this.createdSince("belief", settings.get().stack.belief_card_every_days) > 0 || this.coolingDown("cards:belief")) return null;
    const asked = new Set(this.svc.db.all<{ ref_id: string }>("SELECT ref_id FROM cards WHERE source = 'belief'").map((r) => r.ref_id));
    const b = beliefs.list({ status: ["proposed"] }).find((x) => !asked.has(x.id));
    if (b) {
      return this.create({
        kind: "pick",
        source: "belief",
        ref_id: b.id,
        title: b.statement,
        why: "I think this is true, but you haven't said so.",
        options: [opt("yes", "That's right", { t: "belief", confirm: true }), opt("no", "Not really", { t: "belief", confirm: false })],
        data: { kind: "belief" },
        priority: 20,
      });
    }
    const p = proposals.pending().find((x) => x.change.op === "add_belief" && x.change.belief.provenance === "inferred" && !asked.has(x.id));
    if (!p || p.change.op !== "add_belief") return null;
    return this.create({
      kind: "pick",
      source: "belief",
      ref_id: p.id,
      title: p.change.belief.statement,
      why: "I picked this up from what you said, but you didn't say it outright.",
      options: [opt("yes", "That's right", { t: "belief", confirm: true }), opt("no", "Not really", { t: "belief", confirm: false })],
      data: { kind: "proposal" },
      priority: 20,
    });
  }

  forQuestion(q: QuestionView): Card {
    return this.create({
      kind: "pick",
      source: "question",
      ref_id: q.id,
      title: q.text,
      why: q.why,
      options: [opt("yes", "Yes", { t: "answer", text: "Yes" }), opt("no", "No", { t: "answer", text: "No" })],
      priority: 45,
    });
  }

  /** Work he asked for is ready. */
  forArtifact(artifactId: string, title: string, result: string, itemId: string | null): Card {
    return this.create({
      kind: "know",
      source: "artifact",
      ref_id: artifactId,
      item_ids: itemId ? [itemId] : [],
      title: `${title} is ready`,
      why: result,
      options: [opt("open", "Open it", { t: "open_artifact" })],
      priority: 50,
    });
  }

  /** Something external waiting for his explicit confirmation. "Yes" opens it; it never sends. */
  forAction(actionId: string): Card | null {
    const a = this.svc.actions.get(actionId);
    if (!a || a.status !== "pending") return null;
    return this.create({
      kind: "do",
      source: "action",
      ref_id: actionId,
      title: `Send the email to ${a.preview.to}?`,
      why: a.preview.subject ? `“${a.preview.subject}” is drafted and waiting for you.` : "The draft is waiting for you.",
      options: [opt("review", "Review and send", { t: "open_action" })],
      priority: 70,
    });
  }

  /** The weekly review, as a heads-up. */
  forReview(m: MessageView): Card {
    return this.create({
      kind: "know",
      source: "review",
      ref_id: m.id,
      title: m.headline,
      why: "Your week, in a few lines.",
      options: [opt("ok", "Got it", { t: "ack" })],
      data: { message_id: m.id },
      priority: 25,
    });
  }

  /** The occasional cards: one rule approval a week, one inference every few days. */
  refreshPeriodic(): void {
    for (const r of this.svc.rules.list().proposed) if (this.forRuleApproval(r.id)) break;
    this.forBelief();
    for (const a of this.svc.actions.pending()) this.forAction(a.id);
  }

  // -------------------------------------------------------------------------
  // The stack
  // -------------------------------------------------------------------------

  private score(c: Card): number {
    const fresh = this.now().getTime() - Date.parse(c.created_at) < 15 * 60_000;
    return c.priority + (c.time_sensitive ? 100 : 0) + (fresh && (c.source === "filing" || c.source === "proposal") ? 150 : 0) - 15 * c.returns;
  }

  private visible(): Card[] {
    const { db } = this.svc;
    const now = this.now().toISOString();
    db.run("UPDATE cards SET status = 'expired', updated_at = ? WHERE status IN ('active', 'snoozed') AND expires_at IS NOT NULL AND expires_at <= ?", [now, now]);
    db.run("UPDATE cards SET status = 'active', updated_at = ? WHERE status = 'snoozed' AND snoozed_until <= ?", [now, now]);
    return db
      .all("SELECT * FROM cards WHERE status = 'active' AND visible_from <= ? ORDER BY created_at", [now])
      .map(rowToCard)
      .sort((a, b) => this.score(b) - this.score(a));
  }

  stack(): StackView {
    const { scheduler, settings } = this.svc;
    const all = this.visible();
    const max = settings.get().stack.max_cards;
    const cards = all.slice(0, max).map((c) => this.view(c));
    const next = scheduler.pending({ from: this.now() }).find((w) => w.kind !== "event" && w.kind !== "executor");
    return {
      cards,
      waiting: Math.max(0, all.length - cards.length),
      all_clear: cards.length ? null : { next_check_in: next ? scheduler.view(next) : null },
      morning: this.morning(),
    };
  }

  private morning(): StackView["morning"] {
    const { db, settings } = this.svc;
    const local = DateTime.fromJSDate(this.now()).setZone(settings.tz());
    if (local.hour >= 12) return null;
    const b = db.get<{ id: string; spoken: string }>("SELECT id, spoken FROM briefs WHERE date = ?", [local.toISODate()]);
    return b ? { brief_id: b.id, text: stripTokens(b.spoken) } : null;
  }

  /** When a queued card should appear: the next morning stack. */
  nextMorning(): Date {
    const { settings, db } = this.svc;
    const s = settings.get();
    const tz = settings.tz();
    const now = this.now();
    const today = localDateKey(now, tz);
    const todays = atLocal(today, s.brief_time, tz);
    if (now < todays && !db.get("SELECT id FROM briefs WHERE date = ?", [today])) return todays;
    return atLocal(DateTime.fromJSDate(now).setZone(tz).plus({ days: 1 }).toISODate()!, s.brief_time, tz);
  }

  // -------------------------------------------------------------------------
  // Layers
  // -------------------------------------------------------------------------

  private hydrate(list: Item[]): HydratedItem[] {
    const { items, clock, settings } = this.svc;
    return list.map((i) => items.hydrate(i, clock.now(), settings.tz()));
  }

  /** The thread's few relevant parts: what the card is about first, then what's due or nearly done. */
  private threadParts(c: Card, limit: number): Item[] {
    const { items } = this.svc;
    const cited = items.byIds(c.item_ids);
    const rest = c.thread_id ? items.list({ thread_id: c.thread_id, open: true }).filter((i) => !c.item_ids.includes(i.id) && i.type !== "project") : [];
    rest.sort((a, b) => {
      const near = (i: Item) => (["drafted", "almost_done"].includes(i.status) ? 0 : 1);
      const due = (i: Item) => (i.due_at ? Date.parse(i.due_at) : Infinity);
      return due(a) - due(b) || near(a) - near(b);
    });
    return [...cited, ...rest].slice(0, limit);
  }

  layer2(id: string): CardLayer2 {
    const c = this.get(id);
    if (!c) throw new Error("That card is gone");
    const { proposals, rules, messages, questions, beliefs } = this.svc;
    const out: CardLayer2 = { card_id: c.id, parts: [], options: c.options.map(({ act: _a, ...o }) => o), filed: [], paragraphs: [], shadow: null };
    switch (c.source) {
      case "message": {
        out.parts = this.hydrate(this.threadParts(c, 5));
        break;
      }
      case "filing": {
        out.filed = proposals.batch(String(c.data.batch_id)).map((p): FiledEntry => ({ proposal_id: p.id, summary: p.summary, status: p.status === "undone" ? "undone" : p.status === "accepted" ? "filed" : "needs_you" }));
        break;
      }
      case "proposal": {
        const quote = c.data.quote as string | null;
        if (quote) out.paragraphs.push(`You said: “${quote}”`);
        out.parts = this.hydrate(this.threadParts(c, 4));
        break;
      }
      case "rule": {
        const r = rules.view(c.ref_id!);
        if (r) {
          out.paragraphs.push(r.readable);
          out.shadow = r.shadow ?? null;
        }
        break;
      }
      case "belief": {
        if (c.data.kind === "belief") {
          const b = beliefs.get(c.ref_id!);
          if (b) out.paragraphs.push(`${Math.round(b.confidence * 100)}% sure, from what I've seen so far.`);
        } else {
          const p = proposals.get(c.ref_id!);
          if (p?.reason) out.paragraphs.push(`You said: “${p.reason}”`);
        }
        break;
      }
      case "question": {
        const q = questions.get(c.ref_id!);
        if (q) out.paragraphs.push(q.why);
        break;
      }
      case "review": {
        const m = messages.get(String(c.data.message_id));
        if (m) out.paragraphs.push(...m.because.split(/\n{2,}/).filter(Boolean));
        break;
      }
      case "artifact":
      case "action":
        out.parts = this.hydrate(this.threadParts(c, 4));
        break;
    }
    return out;
  }

  layer3(id: string): CardLayer3 {
    const c = this.get(id);
    if (!c) throw new Error("That card is gone");
    const { db, executors, actions, messages, rules, items } = this.svc;
    const out: CardLayer3 = { card_id: c.id, artifact: null, action: null, paragraphs: [], rule: null, items: [] };
    if (c.source === "artifact") out.artifact = executors.artifact(c.ref_id!);
    if (c.source === "action") out.action = actions.get(c.ref_id!);
    if (c.source === "message" && c.item_ids.length) {
      const a = db.get<{ id: string }>(`SELECT id FROM artifacts WHERE item_id IN (${c.item_ids.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 1`, c.item_ids);
      if (a) out.artifact = executors.artifact(a.id);
    }
    const ruleId = c.source === "rule" ? c.ref_id : c.source === "message" ? (c.data.rule_id as string | null) : null;
    const r = ruleId ? rules.view(ruleId) : null;
    if (r) out.rule = { name: r.name, sentence: r.readable, evidence: r.evidence };
    if (c.source === "message") {
      const m = messages.get(String(c.data.message_id));
      if (m?.because) out.paragraphs.push(m.because);
    }
    const thread = c.thread_id ? items.list({ thread_id: c.thread_id, open: true }) : items.byIds(c.item_ids);
    for (const it of thread) {
      const d = it.data as Record<string, unknown>;
      if (typeof d.next_step === "string" && d.next_step) out.paragraphs.push(`${it.title}: next, ${d.next_step}`);
      if (typeof d.notes === "string" && d.notes) out.paragraphs.push(`${it.title}: ${d.notes}`);
    }
    out.items = this.hydrate(thread.filter((i) => !i.parent_id));
    return out;
  }

  // -------------------------------------------------------------------------
  // Responses
  // -------------------------------------------------------------------------

  async respond(id: string, response: CardResponse, optionKey?: string | null): Promise<CardResult> {
    const c = this.get(id);
    if (!c) throw new Error("That card is gone");
    if (c.status !== "active" && c.status !== "snoozed") throw new Error("That card was already answered");
    const { responder, items, engine, settings, log, bus } = this.svc;
    const messageId = c.source === "message" ? String(c.data.message_id) : null;
    const result: CardResult = { card: this.view(c), summary: "", open: null, exec_task_id: null, returns_at: null };
    let status: Card["status"] = "done";
    switch (response) {
      case "yes": {
        const o = c.options.find((x) => x.key === optionKey) ?? c.options[0];
        const r = await this.act(c, o.act);
        result.summary = r.summary;
        result.open = r.open;
        result.exec_task_id = r.exec_task_id;
        if (r.keepOpen) status = "active";
        break;
      }
      case "not_now": {
        const at = this.returnTime(c);
        this.svc.db.run("UPDATE cards SET status = 'snoozed', snoozed_until = ?, returns = returns + 1, response = 'not_now', responded_at = ?, updated_at = ? WHERE id = ?", [
          at.when.toISOString(),
          this.now().toISOString(),
          this.now().toISOString(),
          c.id,
        ]);
        if (messageId) await responder.respond(messageId, "not_now");
        log.info("card.snoozed", `Not now: "${c.title}". Back ${at.why}`, { card_id: c.id, until: at.when.toISOString() });
        bus.emit({ type: "state.changed", what: ["cards"] });
        return { ...result, card: this.view(this.get(c.id)!), summary: `Back ${at.why}`, returns_at: at.when.toISOString() };
      }
      case "already_done": {
        if (messageId) await responder.respond(messageId, "already_done");
        else for (const it of items.byIds(c.item_ids)) if (it.type !== "event") items.complete(it.id, `card:${c.id}:already_done`);
        if (c.source === "proposal" && this.svc.proposals.get(c.ref_id!)?.status === "pending") this.svc.proposals.reject(c.ref_id!);
        result.summary = "Marked done";
        break;
      }
      case "stop": {
        if (messageId) await responder.respond(messageId, "less_of_this");
        else engine.addCooldown(`cards:${c.source}`, settings.get().rules.less_of_this_cooldown_days * 24, "you asked for less of this");
        status = "dismissed";
        result.summary = "I'll suggest this less";
        break;
      }
    }
    this.svc.db.run("UPDATE cards SET status = ?, response = ?, responded_at = ?, updated_at = ? WHERE id = ?", [status, response, this.now().toISOString(), this.now().toISOString(), c.id]);
    log.info("card.response", `${response === "yes" ? "Yes" : response === "already_done" ? "Already done" : "Stop suggesting this"}: "${c.title}"${result.summary ? ` (${result.summary})` : ""}`, { card_id: c.id, response, option: optionKey ?? null });
    bus.emit({ type: "state.changed", what: ["cards", "items"] });
    return { ...result, card: this.view(this.get(c.id)!) };
  }

  private async act(c: Card, a: Act): Promise<{ summary: string; open: CardResult["open"]; exec_task_id: string | null; keepOpen?: boolean }> {
    const { responder, rules, beliefs, proposals, questions } = this.svc;
    const none = { open: null, exec_task_id: null };
    switch (a.t) {
      case "message": {
        const r = await responder.respond(String(c.data.message_id), "do_it", a.option_key);
        return { summary: r.result?.summary ?? "Done", open: null, exec_task_id: r.result?.exec_task_id ?? null };
      }
      case "rule":
        if (a.approve) rules.approve(c.ref_id!, "user");
        else rules.reject(c.ref_id!);
        return { summary: a.approve ? "Rule turned on" : "Rule turned down", ...none };
      case "belief":
        if (c.data.kind === "belief") {
          if (a.confirm) beliefs.confirm(c.ref_id!);
          else beliefs.remove(c.ref_id!);
        } else if (a.confirm) proposals.accept(c.ref_id!);
        else proposals.reject(c.ref_id!);
        return { summary: a.confirm ? "Noted" : "Dropped it", ...none };
      case "proposal": {
        if (a.accept) proposals.accept(c.ref_id!);
        else proposals.reject(c.ref_id!);
        return { summary: a.accept ? "Filed" : "Left out", ...none };
      }
      case "answer":
        await questions.answer(c.ref_id!, a.text);
        return { summary: "Thanks", ...none };
      case "open_action":
        return { summary: "Review it before it goes", open: { kind: "action", id: c.ref_id! }, exec_task_id: null, keepOpen: true };
      case "open_artifact":
        return { summary: "", open: { kind: "artifact", id: c.ref_id! }, exec_task_id: null };
      case "ack":
        return { summary: "", ...none };
    }
  }

  /**
   * "Not now": Ava picks when it comes back, never sooner than the minimum.
   * Normally at her next check-in after that; after a couple of returns, the
   * next morning stack. Never deleted.
   */
  private returnTime(c: Card): { when: Date; why: string } {
    const { settings, scheduler } = this.svc;
    const s = settings.get();
    const tz = settings.tz();
    const min = new Date(this.now().getTime() + s.stack.min_return_minutes * 60_000);
    if (c.returns >= 2) {
      const m = this.nextMorning();
      const when = m > min ? m : new Date(min);
      return { when, why: `in the morning stack, ${formatClock(when, tz)}` };
    }
    const w = scheduler.pending({ from: min }).find((x) => x.kind !== "event" && x.kind !== "executor");
    let when = w ? new Date(w.due_at) : min;
    if (inQuietHours(when, tz, s.quiet_hours.start, s.quiet_hours.end)) when = nextWakingInstant(when, tz, s.quiet_hours.start, s.quiet_hours.end);
    return { when, why: `at ${formatClock(when, tz)}${w && when.getTime() === Date.parse(w.due_at) ? ", my next check-in" : ""}` };
  }

  /** Items it was about closed: the card has done its job. */
  closeForItem(itemId: string): number {
    const { db } = this.svc;
    const now = this.now().toISOString();
    const n = db.run(`UPDATE cards SET status = 'done', response = 'item_closed', updated_at = ? WHERE status IN ('active', 'snoozed') AND source != 'filing' AND item_ids LIKE ?`, [now, `%"${itemId}"%`]).changes;
    if (n) this.svc.bus.emit({ type: "state.changed", what: ["cards"] });
    return n;
  }

  closeRef(source: CardSource, refId: string, status: "done" | "expired" = "done"): void {
    this.svc.db.run("UPDATE cards SET status = ?, updated_at = ? WHERE source = ? AND ref_id = ? AND status IN ('active', 'snoozed')", [status, this.now().toISOString(), source, refId]);
  }

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  /** Push only time-sensitive cards, at most a few a day, with just the card's one line. */
  async pushIfDue(c: Card, wakeId: string | null): Promise<boolean> {
    const { settings, counters, channels, log, db } = this.svc;
    if (!c.time_sensitive) return false;
    const s = settings.get();
    if (inQuietHours(this.now(), settings.tz(), s.quiet_hours.start, s.quiet_hours.end)) return false;
    const sent = counters.get("push.cards");
    if (sent >= s.notifications.push_per_day) {
      log.info("push.held", `No push for "${c.title}": ${sent} of ${s.notifications.push_per_day} today already; it waits in the stack`, { card_id: c.id }, wakeId);
      return false;
    }
    await channels.pushCard({ card_id: c.id, title: c.title, yes: c.options[0]?.label ?? "Yes" }, wakeId);
    counters.add("push.cards");
    db.run("UPDATE cards SET pushed_at = ? WHERE id = ?", [this.now().toISOString(), c.id]);
    return true;
  }
}
