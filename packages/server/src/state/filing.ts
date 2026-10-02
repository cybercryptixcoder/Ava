import { ChangeSchema, type Change, type Item, type Proposal } from "@ava/shared";
import type { Services } from "../core/services";
import type { ThreadSnapshot } from "./threads";

/** What he said, turned into a change, and whether he said it outright. */
export interface FilingEntry {
  change: Change;
  summary: string;
  reason: string;
  /** False when any part was inferred (a date he didn't give, an implied promise). */
  stated: boolean;
}

/** How to put things back if he undoes an automatic filing. */
export type Undo =
  | { kind: "remove_item"; item_id: string }
  | { kind: "restore_item"; item: Item }
  | { kind: "remove_belief"; belief_id: string }
  | { kind: "restore_belief"; belief_id: string; statement: string; confidence: number; status: string }
  | { kind: "restore_threads"; snapshot: ThreadSnapshot; items: { id: string; thread_id: string | null }[]; created_thread_id: string | null }
  | { kind: "none" };

export interface FilingResult {
  batch_id: string;
  filed: Proposal[];
  needs_you: Proposal[];
  /** Inferences: kept as proposals, surfaced occasionally as a card, never as a list. */
  held: Proposal[];
}

/**
 * Auto-filing. What he states directly is filed straight away, with undo per
 * item. He's asked first only when it is genuinely ambiguous or consequential:
 * anything inferred (a deadline he didn't give), anything involving another
 * person, anything external. Inferred beliefs stay proposals.
 */
export class Filing {
  constructor(private svc: Services) {}

  /** Why this change needs him before it's filed, or null to file it now. */
  needsYou(e: FilingEntry): string | null {
    const c = e.change;
    if (c.op === "create_item") {
      const d = (c.item.data ?? {}) as Record<string, unknown>;
      if (c.item.type === "commitment" || c.item.type === "open_loop" || d.to_person) return "It involves someone else.";
      if (!e.stated && c.item.due_at) return "I inferred the date.";
      if (!e.stated) return "I read between the lines.";
      return null;
    }
    if (c.op === "add_belief") return null;
    if (!e.stated) return "I wasn't sure you meant this.";
    return null;
  }

  file(entries: FilingEntry[], opts: { origin: string; evidence_id: string | null }): FilingResult {
    const { proposals, log } = this.svc;
    const valid = entries.filter((e) => {
      const ok = ChangeSchema.safeParse(e.change).success;
      if (!ok) log.warn("filing.invalid", `Dropped an invalid change: ${e.summary}`, { change: e.change });
      return ok;
    });
    const decisions = valid.map((e) => ({ e, why: this.needsYou(e), held: e.change.op === "add_belief" && e.change.belief.provenance === "inferred" }));
    const batch = proposals.createBatch(
      opts.origin,
      decisions.map((d) => ({ change: d.e.change, summary: d.e.summary, reason: d.e.reason, evidence_id: opts.evidence_id })),
    );
    const out: FilingResult = { batch_id: batch.batch_id, filed: [], needs_you: [], held: [] };
    // Every change was valid, so proposals and decisions line up one to one. Projects first so tasks can link to them.
    const ordered = batch.proposals.map((p, i) => ({ p, d: decisions[i] })).sort((a, b) => Number(isProject(b.p.change)) - Number(isProject(a.p.change)));
    for (const { p, d } of ordered) {
      if (d?.held) {
        out.held.push(p);
        continue;
      }
      if (d?.why) {
        out.needs_you.push(p);
        this.svc.cards.forProposal(p, d.why);
        continue;
      }
      try {
        out.filed.push(this.fileOne(p));
      } catch (e) {
        log.warn("filing.failed", `Couldn't file "${p.summary}": ${(e as Error).message}`, { proposal_id: p.id });
        out.needs_you.push(p);
        this.svc.cards.forProposal(p, "I couldn't file this as it stands.");
      }
    }
    if (out.filed.length || out.needs_you.length) {
      log.info("filing.done", `Filed ${out.filed.length}, ${out.needs_you.length} need${out.needs_you.length === 1 ? "s" : ""} you, ${out.held.length} inference${out.held.length === 1 ? "" : "s"} held`, {
        batch_id: batch.batch_id,
        filed: out.filed.map((p) => p.summary),
        needs_you: out.needs_you.map((p) => p.summary),
      });
    }
    if (out.filed.length) this.svc.cards.forFiling(batch.batch_id, out.filed.length, out.needs_you.length);
    return out;
  }

  /** Apply one proposal now, recording how to undo it. */
  private fileOne(p: Proposal): Proposal {
    const { proposals, items, beliefs, threads } = this.svc;
    const c = p.change;
    const beforeItem = "item_id" in c && c.item_id ? items.get(c.item_id) : null;
    const threadIds = c.op === "rename_thread" ? [c.thread_id] : c.op === "merge_threads" ? [...c.thread_ids, c.into_thread_id] : c.op === "move_to_thread" && c.thread_id ? [c.thread_id] : [];
    const snap = c.op === "rename_thread" || c.op === "merge_threads" || c.op === "move_to_thread" ? threads.snapshot(threadIds) : null;
    const movedBefore = c.op === "move_to_thread" ? items.byIds(c.item_ids).map((i) => ({ id: i.id, thread_id: i.thread_id })) : [];
    const beforeBelief = c.op === "update_belief" ? beliefs.get(c.belief_id) : null;
    const { result } = proposals.accept(p.id);
    let undo: Undo = { kind: "none" };
    switch (c.op) {
      case "create_item":
        undo = { kind: "remove_item", item_id: (result as Item).id };
        break;
      case "update_item":
      case "set_status":
      case "complete_item":
      case "reschedule":
        if (beforeItem) undo = { kind: "restore_item", item: beforeItem };
        break;
      case "add_belief":
        undo = { kind: "remove_belief", belief_id: (result as { id: string }).id };
        break;
      case "update_belief":
        if (beforeBelief) undo = { kind: "restore_belief", belief_id: beforeBelief.id, statement: beforeBelief.statement, confidence: beforeBelief.confidence, status: beforeBelief.status };
        break;
      case "rename_thread":
      case "merge_threads":
        undo = { kind: "restore_threads", snapshot: snap!, items: [], created_thread_id: null };
        break;
      case "move_to_thread": {
        const target = result as { id: string };
        undo = { kind: "restore_threads", snapshot: snap!, items: movedBefore, created_thread_id: c.thread_id ? null : target.id };
        break;
      }
      case "answer_question":
        break;
    }
    proposals.markAuto(p.id, undo);
    return proposals.get(p.id)!;
  }

  /** Undo one automatically filed change. */
  undo(proposalId: string): Proposal {
    const { proposals, items, beliefs, threads, log } = this.svc;
    const p = proposals.get(proposalId);
    if (!p) throw new Error(`No filed change ${proposalId}`);
    if (p.status === "undone") return p;
    const { auto, undo } = proposals.undoOf<Undo>(proposalId);
    if (!auto || p.status !== "accepted" || !undo || undo.kind === "none") throw new Error("This one can't be undone from here");
    switch (undo.kind) {
      case "remove_item":
        items.remove(undo.item_id, "undo");
        break;
      case "restore_item": {
        const b = undo.item;
        items.update(b.id, { title: b.title, status: b.status, data: b.data, due_at: b.due_at, start_at: b.start_at, end_at: b.end_at, project_id: b.project_id, thread_id: b.thread_id, parent_id: b.parent_id }, "undo");
        break;
      }
      case "remove_belief":
        beliefs.remove(undo.belief_id);
        break;
      case "restore_belief":
        beliefs.edit(undo.belief_id, { statement: undo.statement, confidence: undo.confidence, status: undo.status as never });
        break;
      case "restore_threads":
        threads.restore(undo.snapshot, undo.items);
        if (undo.created_thread_id) threads.removeIfEmpty(undo.created_thread_id);
        break;
    }
    log.info("filing.undone", `Undid: ${p.summary}`, { proposal_id: p.id });
    this.svc.bus.emit({ type: "state.changed", what: ["items", "cards"] });
    return proposals.markUndone(p.id);
  }
}

function isProject(c: Change): boolean {
  return c.op === "create_item" && c.item.type === "project";
}
