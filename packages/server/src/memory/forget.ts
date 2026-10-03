import type { MemoryForgetClosure } from "@ava/shared";
import type { Services } from "../core/services";

/**
 * The forget flow behind every deletion UI and the voice flow: resolve a
 * target to raw entry ids, preview exactly what removal would take (raw
 * entries; facts that lose their last source; gists that get rebuilt or
 * disappear), and apply it. Forgetting is the only deletion path, and it
 * always runs through a preview the user confirms first.
 */
export class ForgetFlow {
  constructor(private svc: Services) {}

  /** Raw entry ids behind a target. Episodes and facts resolve to their raw sources; a query searches entries. */
  resolve(target: { entry_ids?: string[]; episode_id?: string; fact_id?: string; query?: string }): string[] {
    const { db } = this.svc;
    const alive = (id: string) => !!db.get("SELECT 1 FROM entries WHERE id = ? AND deleted_at IS NULL", [id]);
    if (target.entry_ids?.length) return [...new Set(target.entry_ids)].filter(alive);
    if (target.episode_id) return this.svc.memory.episodeEntries(target.episode_id).filter(alive);
    if (target.fact_id) {
      return db
        .all<{ entry_id: string }>("SELECT fe.entry_id FROM fact_entries fe JOIN entries e ON e.id = fe.entry_id WHERE fe.fact_id = ? AND e.deleted_at IS NULL", [target.fact_id])
        .map((r) => r.entry_id);
    }
    if (target.query) return this.svc.memorySearch.search(target.query, { kinds: ["entry"], limit: 12 }).map((h) => h.ref_id);
    return [];
  }

  /** What exactly would be removed or rebuilt — the confirmation shows this before anything happens. */
  preview(entryIds: string[]): MemoryForgetClosure {
    const { db, cipher } = this.svc;
    const ids = [...new Set(entryIds)].filter((id) => !!db.get("SELECT 1 FROM entries WHERE id = ? AND deleted_at IS NULL", [id]));
    if (!ids.length) return { entries: [], facts: [], episodes_stale: [], episodes_removed: [] };
    const ph = ids.map(() => "?").join(",");
    const entries = db
      .all<{ id: string; kind: string; occurred_at: string; text_enc: string }>(`SELECT id, kind, occurred_at, text_enc FROM entries WHERE id IN (${ph}) ORDER BY occurred_at`, ids)
      .map((r) => ({ id: r.id, kind: r.kind, at: r.occurred_at, preview: (cipher.decOpt(r.text_enc) ?? "").slice(0, 140) }));
    const facts: MemoryForgetClosure["facts"] = [];
    for (const f of db.all<{ id: string; statement_enc: string }>(`SELECT DISTINCT f.id, f.statement_enc FROM facts f JOIN fact_entries fe ON fe.fact_id = f.id WHERE fe.entry_id IN (${ph}) AND f.status != 'removed'`, ids)) {
      const remaining = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM fact_entries fe JOIN entries e ON e.id = fe.entry_id WHERE fe.fact_id = ? AND e.deleted_at IS NULL AND fe.entry_id NOT IN (${ph})`,
        [f.id, ...ids],
      )?.n;
      if (!remaining) facts.push({ id: f.id, statement: (cipher.decOpt(f.statement_enc) ?? "").slice(0, 200) });
    }
    const episodes_stale: MemoryForgetClosure["episodes_stale"] = [];
    const episodes_removed: MemoryForgetClosure["episodes_removed"] = [];
    for (const ep of db.all<{ id: string; gist_enc: string | null }>(`SELECT DISTINCT ep.id, ep.gist_enc FROM episodes ep JOIN episode_entries ee ON ee.episode_id = ep.id WHERE ee.entry_id IN (${ph})`, ids)) {
      const remaining = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM episode_entries ee JOIN entries e ON e.id = ee.entry_id WHERE ee.episode_id = ? AND e.deleted_at IS NULL AND ee.entry_id NOT IN (${ph})`,
        [ep.id, ...ids],
      )?.n;
      const item = { id: ep.id, gist: (cipher.decOpt(ep.gist_enc ?? "") ?? "").slice(0, 160) };
      if (!remaining) episodes_removed.push(item);
      else episodes_stale.push(item);
    }
    return { entries, facts, episodes_stale, episodes_removed };
  }

  /** Apply the confirmed closure: forget the raw entries, then take the derived layers down with them — now, not at night. */
  async apply(entryIds: string[], reason: string): Promise<{ summary: string; closure: MemoryForgetClosure }> {
    const closure = this.preview(entryIds);
    const ids = closure.entries.map((e) => e.id);
    if (!ids.length) return { summary: "Nothing left to forget", closure };
    // `forget` fires the watchers: index text and vectors go, episodes go stale, orphaned facts are removed.
    this.svc.memory.forget(ids, reason);
    let revised = 0;
    let removed = 0;
    for (const ep of closure.episodes_stale) {
      const out = await this.svc.memoryProcessor.regenerateGist(ep.id);
      if (out === "revised") revised++;
      else if (out === "removed") removed++;
    }
    for (const ep of closure.episodes_removed) {
      const out = await this.svc.memoryProcessor.regenerateGist(ep.id);
      if (out === "removed") removed++;
    }
    // A forgotten fact must not survive in the core: rebuild it right away when anything derived left.
    if ((closure.facts.length || revised || removed) && this.svc.models.available) {
      const hadCore = !!this.svc.core.latest();
      this.svc.core.invalidate();
      if (hadCore) await this.svc.core.rebuild();
    }
    const bits = [
      `${ids.length} raw ${ids.length === 1 ? "entry" : "entries"} forgotten`,
      closure.facts.length ? `${closure.facts.length} derived ${closure.facts.length === 1 ? "fact" : "facts"} removed` : "",
      revised ? `${revised} ${revised === 1 ? "gist" : "gists"} rebuilt from what remains` : "",
      removed ? `${removed} ${removed === 1 ? "gist" : "gists"} removed` : "",
    ].filter(Boolean);
    this.svc.log.info("memory.forget_flow", `Forget flow: ${bits.join("; ")}`, { entries: ids.length, facts: closure.facts.length, revised, removed });
    return { summary: bits.join("; "), closure };
  }
}
