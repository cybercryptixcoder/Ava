import { ChangeSchema, ITEM_TYPES, statusLabel, type Change, type Proposal } from "@ava/shared";
import type { Db } from "../db/db";
import { j, js, newId } from "../db/db";
import type { Clock } from "../core/clock";
import type { ItemStore } from "./items";
import type { BeliefStore } from "./beliefs";
import type { EvidenceStore } from "./evidence";
import type { DecisionLog } from "../core/log";
import type { ThreadStore } from "./threads";

export interface QuestionAnswerHandler {
  (questionId: string, answer: string): void;
}

function rowToProposal(r: Record<string, unknown>): Proposal {
  return {
    id: String(r.id),
    batch_id: String(r.batch_id),
    origin: String(r.origin),
    change: j(r.change, { op: "complete_item", item_id: "" } as Change),
    summary: String(r.summary),
    reason: (r.reason as string) ?? null,
    status: r.status as Proposal["status"],
    weight: r.weight === null ? null : Number(r.weight),
    evidence_id: (r.evidence_id as string) ?? null,
    created_at: String(r.created_at),
    resolved_at: (r.resolved_at as string) ?? null,
  };
}

/**
 * Confirmation chips. Extracted changes wait here until accepted (as is or
 * edited) or rejected, individually or as a batch.
 */
export class ProposalStore {
  answerQuestion: QuestionAnswerHandler = () => {};

  constructor(
    private db: Db,
    private clock: Clock,
    private items: ItemStore,
    private beliefs: BeliefStore,
    private evidence: EvidenceStore,
    private log: DecisionLog,
    private threads: ThreadStore,
  ) {}

  /** Human-readable chip text for a change. */
  describe(c: Change): string {
    switch (c.op) {
      case "create_item": {
        const label = ITEM_TYPES[c.item.type]?.label ?? c.item.type;
        const due = c.item.due_at ? ` due ${new Date(c.item.due_at).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
        return `New ${label.toLowerCase()}: ${c.item.title}${due}`;
      }
      case "update_item":
        return `Update ${this.items.get(c.item_id)?.title ?? c.item_id}`;
      case "set_status":
        return `Mark ${this.items.get(c.item_id)?.title ?? c.item_id} as ${statusLabel(c.status).toLowerCase()}`;
      case "complete_item":
        return `Mark ${this.items.get(c.item_id)?.title ?? c.item_id} done`;
      case "reschedule":
        return `Move ${this.items.get(c.item_id)?.title ?? c.item_id}`;
      case "add_belief":
        return `${c.belief.provenance === "inferred" ? "Ava thinks" : "Note"}: ${c.belief.statement}`;
      case "update_belief":
        return `Revise belief ${c.belief_id}`;
      case "answer_question":
        return `Answer: ${c.answer}`;
      case "rename_thread":
        return `Rename "${this.threads.get(c.thread_id)?.title ?? "a thread"}" to "${c.title}"`;
      case "merge_threads":
        return `Fold ${c.thread_ids.map((id) => `"${this.threads.get(id)?.title ?? "a thread"}"`).join(", ")} into "${this.threads.get(c.into_thread_id)?.title ?? "a thread"}"`;
      case "move_to_thread":
        return `Move ${c.item_ids.length === 1 ? (this.items.get(c.item_ids[0])?.title ?? "an item") : `${c.item_ids.length} items`} to "${c.thread_id ? (this.threads.get(c.thread_id)?.title ?? "a thread") : c.thread_title}"`;
    }
  }

  createBatch(
    origin: string,
    entries: { change: Change; summary?: string; reason?: string | null; weight?: number | null; evidence_id?: string | null }[],
  ): { batch_id: string; proposals: Proposal[] } {
    const batch_id = newId("bat");
    const now = this.clock.now().toISOString();
    const out: Proposal[] = [];
    for (const e of entries) {
      const parsed = ChangeSchema.safeParse(e.change);
      if (!parsed.success) {
        this.log.warn("proposal.invalid", `Dropped an invalid extracted change from ${origin}`, { change: e.change, issues: parsed.error.issues });
        continue;
      }
      const id = newId("prp");
      this.db.run(
        "INSERT INTO proposals (id, batch_id, origin, change, summary, reason, status, weight, evidence_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
        [id, batch_id, origin, js(parsed.data), e.summary ?? this.describe(parsed.data), e.reason ?? null, e.weight ?? null, e.evidence_id ?? null, now],
      );
      out.push(this.get(id)!);
    }
    return { batch_id, proposals: out };
  }

  get(id: string): Proposal | null {
    const r = this.db.get("SELECT * FROM proposals WHERE id = ?", [id]);
    return r ? rowToProposal(r) : null;
  }

  batch(batchId: string): Proposal[] {
    return this.db.all("SELECT * FROM proposals WHERE batch_id = ? ORDER BY created_at, rowid", [batchId]).map(rowToProposal);
  }

  pending(opts: { origin?: string; limit?: number } = {}): Proposal[] {
    const rows = opts.origin
      ? this.db.all("SELECT * FROM proposals WHERE status = 'pending' AND origin = ? ORDER BY COALESCE(weight, 0) DESC, created_at LIMIT ?", [opts.origin, opts.limit ?? 200])
      : this.db.all("SELECT * FROM proposals WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?", [opts.limit ?? 200]);
    return rows.map(rowToProposal);
  }

  pendingCountByOrigin(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.all<{ origin: string; n: number }>("SELECT origin, COUNT(*) AS n FROM proposals WHERE status = 'pending' GROUP BY origin")) out[r.origin] = r.n;
    return out;
  }

  accept(id: string, edited?: Change): { proposal: Proposal; result: unknown } {
    const p = this.get(id);
    if (!p) throw new Error(`No proposal ${id}`);
    if (p.status !== "pending") return { proposal: p, result: null };
    const change = edited ? ChangeSchema.parse(edited) : p.change;
    const result = this.db.tx(() => {
      const r = this.apply(change, `chip:${p.origin}`, p);
      this.db.run("UPDATE proposals SET status = 'accepted', change = ?, resolved_at = ? WHERE id = ?", [js(change), this.clock.now().toISOString(), id]);
      return r;
    });
    this.log.info("proposal.accepted", `Accepted: ${p.summary}${edited ? " (edited)" : ""}`, { proposal_id: id, change });
    return { proposal: this.get(id)!, result };
  }

  reject(id: string): Proposal {
    const p = this.get(id);
    if (!p) throw new Error(`No proposal ${id}`);
    this.db.run("UPDATE proposals SET status = 'rejected', resolved_at = ? WHERE id = ? AND status = 'pending'", [this.clock.now().toISOString(), id]);
    this.log.info("proposal.rejected", `Rejected: ${p.summary}`, { proposal_id: id });
    return this.get(id)!;
  }

  resolveBatch(batchId: string, decision: "accept" | "reject", only?: string[]): Proposal[] {
    const ps = this.batch(batchId).filter((p) => p.status === "pending" && (!only || only.includes(p.id)));
    // Projects first so tasks can link to them by title.
    ps.sort((a, b) => Number(isProjectCreate(b.change)) - Number(isProjectCreate(a.change)));
    for (const p of ps) {
      if (decision === "accept") {
        try {
          this.accept(p.id);
        } catch (e) {
          this.log.warn("proposal.apply_failed", `Could not apply "${p.summary}": ${(e as Error).message}`, { proposal_id: p.id });
        }
      } else this.reject(p.id);
    }
    return this.batch(batchId);
  }

  /** Apply a change to the life model. Also used directly for one-tap check-offs. */
  apply(change: Change, via: string, proposal?: Proposal): unknown {
    switch (change.op) {
      case "create_item": {
        let project_id = change.item.project_id ?? null;
        if (!project_id && change.project_title) {
          const existing = this.items.list({ types: ["project"], q: change.project_title }).find((p) => p.title.toLowerCase() === change.project_title!.toLowerCase());
          project_id = existing?.id ?? null;
        }
        const draft = { ...change.item, project_id };
        // File it under its thread before creation, so the item is never threadless.
        const thread_id = draft.thread_id ?? (this.threads.threadable(draft) ? this.threads.resolve(draft, change.thread_title) : null);
        const item = this.items.create({ ...draft, thread_id }, { source: via.startsWith("chip:") ? via.slice(5) : via, via });
        if (thread_id) this.threads.enforceCap();
        if (proposal?.evidence_id) this.evidence.linkItem(item.id, proposal.evidence_id);
        return item;
      }
      case "update_item":
        return this.items.update(change.item_id, change.patch, via);
      case "set_status":
        return this.items.setStatus(change.item_id, change.status, via);
      case "complete_item":
        return this.items.complete(change.item_id, via);
      case "reschedule":
        return this.items.update(change.item_id, { due_at: change.due_at, start_at: change.start_at, end_at: change.end_at }, via);
      case "add_belief":
        return this.beliefs.add({
          ...change.belief,
          // Accepting a chip is Shreyas confirming it.
          confirmed: true,
          evidence_ids: proposal?.evidence_id ? [proposal.evidence_id] : [],
        });
      case "update_belief":
        return this.beliefs.edit(change.belief_id, { statement: change.statement, confidence: change.confidence, status: change.status });
      case "answer_question":
        this.answerQuestion(change.question_id, change.answer);
        return null;
      case "rename_thread":
        return this.threads.rename(change.thread_id, change.title, via);
      case "merge_threads":
        return this.threads.merge(change.thread_ids, change.into_thread_id, via);
      case "move_to_thread":
        return this.threads.move(change.item_ids, { thread_id: change.thread_id, title: change.thread_title }, via);
    }
  }

  /** Record that a proposal was filed automatically, with what undoing it takes. */
  markAuto(id: string, undo: unknown): void {
    this.db.run("UPDATE proposals SET auto = 1, undo = ? WHERE id = ?", [js(undo), id]);
  }

  undoOf<T>(id: string): { auto: boolean; undo: T | null } {
    const r = this.db.get<{ auto: number; undo: string | null }>("SELECT auto, undo FROM proposals WHERE id = ?", [id]);
    return { auto: !!r?.auto, undo: j<T | null>(r?.undo, null) };
  }

  markUndone(id: string): Proposal {
    this.db.run("UPDATE proposals SET status = 'undone', resolved_at = ? WHERE id = ?", [this.clock.now().toISOString(), id]);
    return this.get(id)!;
  }

  supersedePendingFor(itemId: string): void {
    for (const p of this.pending()) {
      const c = p.change as { item_id?: string };
      if (c.item_id === itemId) {
        this.db.run("UPDATE proposals SET status = 'superseded', resolved_at = ? WHERE id = ?", [this.clock.now().toISOString(), p.id]);
      }
    }
  }
}

function isProjectCreate(c: Change): boolean {
  return c.op === "create_item" && c.item.type === "project";
}
