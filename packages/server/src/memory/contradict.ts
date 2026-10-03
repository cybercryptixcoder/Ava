import { z } from "zod";
import type { Services } from "../core/services";

const PairsSchema = z.object({
  pairs: z
    .array(
      z.object({
        new_id: z.string().max(60),
        supersedes: z.array(z.string().max(60)).max(6).default([]),
        reason: z.string().max(200).default(""),
      }),
    )
    .max(12),
});

/**
 * L2's guard. When new facts land, a cheap-model judge checks them against
 * existing current facts with overlapping words; a genuine contradiction
 * supersedes: the old fact's valid_to is set to the new fact's time and
 * linked through superseded_by. Nothing is ever overwritten — the old row
 * stays, the change is visible, and every decision is logged with its reason.
 */
export class Contradictor {
  constructor(private svc: Services) {}

  /** Judge new facts against current facts. Returns how many were superseded. */
  async review(newFactIds: string[]): Promise<number> {
    const { db, cipher, models, cfg, log } = this.svc;
    if (!models.available || !newFactIds.length) return 0;
    const fresh = new Set(newFactIds);
    const news: { id: string; statement: string }[] = [];
    for (const id of newFactIds.slice(0, 10)) {
      const r = db.get<{ statement_enc: string }>("SELECT statement_enc FROM facts WHERE id = ? AND status = 'current'", [id]);
      if (r) news.push({ id, statement: cipher.decOpt(r.statement_enc) ?? "" });
    }
    if (!news.length) return 0;
    const existing = new Map<string, string>();
    for (const n of news) {
      for (const h of this.svc.memorySearch.search(n.statement, { kinds: ["fact"], limit: 6 })) {
        if (fresh.has(h.ref_id) || existing.has(h.ref_id)) continue;
        const r = db.get<{ statement_enc: string; valid_to: string | null; status: string }>("SELECT statement_enc, valid_to, status FROM facts WHERE id = ?", [h.ref_id]);
        if (r && r.status === "current" && !r.valid_to) existing.set(h.ref_id, cipher.decOpt(r.statement_enc) ?? "");
      }
    }
    if (!existing.size) return 0;
    try {
      const r = await models.complete({
        purpose: "memory.contradict",
        origin: "system",
        model: cfg.models.fast,
        maxTokens: 600,
        lowLatency: true,
        schema: PairsSchema,
        system:
          "You maintain a fact store. Given NEW facts and EXISTING facts, list for each new fact any existing facts it genuinely supersedes: same subject, changed value ('the deadline moved to Oct 20' supersedes 'the deadline is Oct 15'; a newer address supersedes the old one). Related-but-compatible facts do not supersede each other, and a more detailed restatement supersedes nothing. Be strict; when unsure, leave it out. Return JSON {pairs: [{new_id, supersedes: [old_id], reason}]}. Empty when nothing is superseded.",
        messages: [{ role: "user", content: JSON.stringify({ new: news, existing: [...existing.entries()].map(([id, statement]) => ({ id, statement })) }) }],
      });
      let applied = 0;
      for (const p of r.parsed?.pairs ?? []) {
        if (!fresh.has(p.new_id)) continue; // only new facts may supersede
        const at = db.get<{ recorded_at: string }>("SELECT recorded_at FROM facts WHERE id = ?", [p.new_id])?.recorded_at ?? this.svc.clock.now().toISOString();
        for (const oldId of p.supersedes.slice(0, 4)) {
          if (!existing.has(oldId) || fresh.has(oldId)) continue;
          const changed = db.run("UPDATE facts SET valid_to = ?, superseded_by = ?, status = 'superseded' WHERE id = ? AND status = 'current' AND valid_to IS NULL", [at, p.new_id, oldId]).changes;
          if (changed) {
            applied++;
            log.info("memory.supersede", `A fact was superseded: "${(existing.get(oldId) ?? "").slice(0, 140)}" → "${(news.find((n) => n.id === p.new_id)?.statement ?? "").slice(0, 140)}"${p.reason ? ` (${p.reason})` : ""}`, {
              old_id: oldId,
              new_id: p.new_id,
              reason: p.reason,
            });
          }
        }
      }
      return applied;
    } catch (e) {
      log.warn("memory.contradict", `Contradiction check skipped: ${(e as Error).message}`);
      return 0;
    }
  }
}
