import { z } from "zod";
import type { QuestionView } from "@ava/shared";
import type { Services } from "../core/services";
import { j, js, newId } from "../db/db";

const AnswerOutput = z.object({
  belief_updates: z.array(
    z.object({
      belief_id: z.string().nullable(),
      area: z.string(),
      statement: z.string(),
      confidence: z.number(),
      retire: z.boolean(),
    }),
  ),
  item_changes: z.array(
    z.object({
      item_id: z.string(),
      status: z.string().nullable(),
      note: z.string(),
    }),
  ),
});

/**
 * Active sensing. During planning Ava picks her most valuable unknown and may
 * ask one question, usually in the morning brief. Answers update beliefs
 * directly (Shreyas stated them); item changes still become chips.
 */
export class QuestionStore {
  constructor(private svc: Services) {}

  private row(r: Record<string, unknown>): QuestionView {
    return { id: String(r.id), text: String(r.text), why: String(r.why), status: String(r.status), answer: (r.answer as string) ?? null };
  }

  add(q: { text: string; why: string; about?: Record<string, unknown> | null }): QuestionView | null {
    const { db, clock, log } = this.svc;
    const pending = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM questions WHERE status IN ('pending','asked')");
    if ((pending?.n ?? 0) >= 1) {
      log.info("question.skipped", `Kept the existing open question instead of adding: ${q.text}`);
      return null;
    }
    const id = newId("qst");
    db.run("INSERT INTO questions (id, text, why, about, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)", [id, q.text, q.why, js(q.about ?? null), clock.now().toISOString()]);
    log.info("question.added", `Ava wants to ask: ${q.text} (${q.why})`, { question_id: id });
    return this.get(id);
  }

  get(id: string): QuestionView | null {
    const r = this.svc.db.get("SELECT * FROM questions WHERE id = ?", [id]);
    return r ? this.row(r) : null;
  }

  open(): QuestionView | null {
    const r = this.svc.db.get("SELECT * FROM questions WHERE status IN ('pending','asked') ORDER BY created_at LIMIT 1");
    return r ? this.row(r) : null;
  }

  markAsked(id: string): void {
    this.svc.db.run("UPDATE questions SET status = 'asked', asked_at = ? WHERE id = ? AND status = 'pending'", [this.svc.clock.now().toISOString(), id]);
  }

  dismiss(id: string): void {
    this.svc.db.run("UPDATE questions SET status = 'dismissed' WHERE id = ?", [id]);
  }

  recent(limit = 10): (QuestionView & { answered_at: string | null })[] {
    return this.svc.db.all("SELECT * FROM questions ORDER BY created_at DESC LIMIT ?", [limit]).map((r) => ({ ...this.row(r), answered_at: (r.answered_at as string) ?? null }));
  }

  async answer(id: string, answer: string): Promise<{ beliefs: number; chips: number }> {
    const { db, clock, evidence, beliefs, proposals, log, models, cfg } = this.svc;
    const q = db.get<Record<string, unknown>>("SELECT * FROM questions WHERE id = ?", [id]);
    if (!q) throw new Error(`No question ${id}`);
    db.run("UPDATE questions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?", [answer, clock.now().toISOString(), id]);
    const evId = evidence.add({ kind: "answer", source: "question", content: { question: q.text, answer }, summary: `Q: ${q.text} A: ${answer}` });
    const about = j<{ belief_id?: string; item_id?: string } | null>(q.about, null);
    let nBeliefs = 0,
      nChips = 0;
    try {
      const known = about?.belief_id ? beliefs.get(about.belief_id) : null;
      const item = about?.item_id ? this.svc.items.get(about.item_id) : null;
      const res = await models.complete({
        purpose: "question.interpret",
        origin: "interactive",
        model: cfg.models.fast,
        maxTokens: 1200,
        schema: AnswerOutput,
        system: "Turn Shreyas's answer to Ava's question into belief updates (things now known about him) and item changes. Only record what the answer actually says. Confidence 0.9 for direct statements.",
        messages: [
          {
            role: "user",
            content: `Question: ${q.text}\nWhy Ava asked: ${q.why}\n${known ? `Belief it was about: ${known.id} "${known.statement}" (${known.area})\n` : ""}${item ? `Item it was about: ${item.id} "${item.title}" [${item.status}]\n` : ""}Answer: ${answer}`,
          },
        ],
      });
      const out = res.parsed;
      if (out) {
        for (const b of out.belief_updates) {
          if (b.belief_id && beliefs.get(b.belief_id)) {
            beliefs.edit(b.belief_id, { statement: b.statement, confidence: b.confidence, status: b.retire ? "retired" : "active" });
            beliefs.linkEvidence(b.belief_id, evId);
          } else beliefs.add({ area: b.area, statement: b.statement, provenance: "stated", confidence: b.confidence, evidence_ids: [evId] });
          nBeliefs++;
        }
        const chips = out.item_changes
          .filter((c) => this.svc.items.get(c.item_id) && c.status)
          .map((c) => ({ change: { op: "set_status" as const, item_id: c.item_id, status: c.status! }, reason: c.note, evidence_id: evId }));
        if (chips.length) nChips = proposals.createBatch("question", chips).proposals.length;
      }
    } catch (e) {
      // Without the model, keep the answer as a stated belief verbatim.
      beliefs.add({ area: "logistics", statement: `${String(q.text).replace(/\?$/, "")}: ${answer}`, provenance: "stated", confidence: 0.9, evidence_ids: [evId] });
      nBeliefs = 1;
      log.warn("question.fallback", `Stored the answer verbatim (${(e as Error).message})`);
    }
    log.info("question.answered", `You answered "${q.text}": ${answer}`, { question_id: id, beliefs: nBeliefs, chips: nChips });
    this.svc.bus.emit({ type: "state.changed", what: ["beliefs", "questions"] });
    return { beliefs: nBeliefs, chips: nChips };
  }
}
