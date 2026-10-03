import type { Services } from "../core/services";

export interface BackfillProgress {
  phase: "turns" | "evidence" | "history" | "done";
  copied: { turns: number; evidence: number; history: number };
  skipped_purged: number;
  errors: number;
  cursor: { ev_at: string; ev_id: string; hist_id: number; hist_max: number | null };
  started_at: string;
  finished_at: string | null;
}

const BATCH = 250;
/** Evidence kinds whose text belongs in the raw log (his words, kept forever). */
const KEPT_EVIDENCE_KINDS = ["transcript", "conversation_import", "email", "note", "answer"];

/**
 * One-time, resumable migration that brings existing data into the raw log:
 * old turns, sourced text (voice notes, imports, sent mail, Wispr notes,
 * question answers) and item history. Runs in small batches between event
 * loop turns so the app stays usable while it works, records progress in
 * memory_state, and is idempotent: every copied entry gets a deterministic
 * id, so an interrupted run resumes without duplicating anything.
 */
export class Backfill {
  private running = false;
  private histMaxAtBoot: number;

  constructor(private svc: Services) {
    // Captured before any new activity: item history up to this id predates the
    // raw log and gets copied; anything after is already logged as it happens.
    this.histMaxAtBoot = this.svc.db.get<{ m: number }>("SELECT COALESCE(MAX(id), 0) AS m FROM item_history")?.m ?? 0;
  }

  progress(): BackfillProgress {
    return (
      this.svc.memory.getState<BackfillProgress>("backfill") ?? {
        phase: "turns",
        copied: { turns: 0, evidence: 0, history: 0 },
        skipped_purged: 0,
        errors: 0,
        cursor: { ev_at: "", ev_id: "", hist_id: 0, hist_max: null },
        started_at: this.svc.clock.now().toISOString(),
        finished_at: null,
      }
    );
  }

  /** Drain everything synchronously (tests, fixtures, the manual route). */
  runAll(): BackfillProgress {
    let guard = 0;
    while (this.step() && guard++ < 10_000) {
      /* keep taking batches */
    }
    return this.progress();
  }

  /** Background kick: one batch per event-loop turn so the app stays usable. */
  kick(): void {
    if (this.running || this.progress().phase === "done") return;
    this.running = true;
    const tick = () => {
      try {
        if (!this.step()) {
          this.running = false;
          return;
        }
        setImmediate(tick);
      } catch (e) {
        this.running = false;
        this.svc.log.warn("memory.backfill", `Backfill paused: ${(e as Error).message}. It resumes on the next boot.`);
      }
    };
    setImmediate(tick);
  }

  /** One batch. Returns true while there is more to do. */
  step(): boolean {
    const st = this.progress();
    if (st.phase === "done") return false;
    if (st.phase === "turns") return this.stepTurns(st);
    if (st.phase === "evidence") return this.stepEvidence(st);
    return this.stepHistory(st);
  }

  /** Copy old conversation turns into the log, then remove the superseded rows. */
  private stepTurns(st: BackfillProgress): boolean {
    const { db, memory } = this.svc;
    const rows = db.all<Record<string, unknown>>("SELECT * FROM turns ORDER BY created_at, rowid LIMIT ?", [BATCH]);
    for (const r of rows) {
      const meta = {
        mode: r.mode,
        input_kind: r.input_kind ?? null,
        operational: !!r.operational,
        affirmation: !!r.affirmation,
        trimmed: !!r.trimmed,
        audio_id: r.audio_id ?? null,
        cues: r.cues ? JSON.parse(String(r.cues)) : null,
        backfilled: true,
      };
      db.run(
        "INSERT OR IGNORE INTO entries (id, kind, source, role, session_id, occurred_at, recorded_at, text_enc, raw_enc, meta) VALUES (?, 'turn', ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          String(r.id),
          r.mode === "live" ? "live" : "conversation",
          r.role === null || r.role === undefined ? null : String(r.role),
          String(r.conversation_id),
          String(r.created_at),
          String(r.created_at),
          String(r.text_enc),
          r.raw_enc === null || r.raw_enc === undefined ? null : String(r.raw_enc),
          JSON.stringify(meta),
        ],
      );
    }
    if (rows.length) db.run(`DELETE FROM turns WHERE id IN (${rows.map(() => "?").join(",")})`, rows.map((r) => String(r.id)));
    st.copied.turns += rows.length;
    if (rows.length < BATCH) st.phase = "evidence";
    memory.setState("backfill", st);
    return true;
  }

  /** Point sourced text at the log; move the text itself in where it lived in evidence. */
  private stepEvidence(st: BackfillProgress): boolean {
    const { db, memory, log } = this.svc;
    const rows = db.all<Record<string, unknown>>(
      `SELECT * FROM evidence WHERE kind IN (${KEPT_EVIDENCE_KINDS.map(() => "?").join(",")}) AND (occurred_at > ? OR (occurred_at = ? AND id > ?)) ORDER BY occurred_at, id LIMIT ?`,
      [...KEPT_EVIDENCE_KINDS, st.cursor.ev_at, st.cursor.ev_at, st.cursor.ev_id, BATCH],
    );
    for (const r of rows) {
      try {
        if (this.evidenceRow(st, r)) st.copied.evidence += 1;
      } catch (e) {
        st.errors += 1;
        log.warn("memory.backfill", `Skipped one evidence row (${String(r.id)}): ${(e as Error).message}`);
      }
      st.cursor.ev_at = String(r.occurred_at);
      st.cursor.ev_id = String(r.id);
    }
    if (rows.length < BATCH) st.phase = "history";
    memory.setState("backfill", st);
    return true;
  }

  /** True when the row's text actually moved into the log. */
  private evidenceRow(st: BackfillProgress, r: Record<string, unknown>): boolean {
    const { db, cipher, memory } = this.svc;
    const content = cipher.decJson(r.content_enc as string, null) as unknown;
    const kind = String(r.kind);
    // New-style rows already reference their entry; nothing to do.
    if (content && typeof content === "object" && content !== null && "entry_id" in content) return false;

    const setRef = (ref: Record<string, unknown>) => db.run("UPDATE evidence SET content_enc = ?, purge_after = NULL WHERE id = ?", [cipher.encJson(ref), String(r.id)]);

    if (kind === "transcript") {
      const refTurn = (r.source_ref as string) ?? null;
      if (refTurn && db.get("SELECT id FROM entries WHERE id = ?", [refTurn])) {
        setRef({ entry_id: refTurn });
        return false;
      }
      const text = typeof content === "string" ? content : String((content as { text?: string } | null)?.text ?? "");
      const id = this.ensureEntry(`ent_${String(r.id)}`, {
        kind: "transcript",
        source: String(r.source),
        text,
        occurred_at: String(r.occurred_at),
        meta: { backfilled: true },
      });
      setRef({ entry_id: id });
      return true;
    }

    if (kind === "conversation_import") {
      const c = content as { title?: string; platform?: string; updated_at?: string; text?: string; purged?: boolean } | null;
      if (!c || !c.text) {
        // Already purged before this upgrade; the text is gone for good.
        st.skipped_purged += 1;
        db.run("UPDATE evidence SET purge_after = NULL WHERE id = ?", [String(r.id)]);
        return false;
      }
      const id = this.ensureEntry(`ent_${String(r.id)}`, {
        kind: "import",
        source: String(r.source),
        session_id: (r.source_ref as string) ?? null,
        occurred_at: String(r.occurred_at),
        text: c.text,
        meta: { title: c.title ?? null, platform: c.platform ?? null, updated_at: c.updated_at ?? null },
      });
      setRef({ entry_id: id, title: c.title ?? null, platform: c.platform ?? null, updated_at: c.updated_at ?? null });
      return true;
    }

    if (kind === "email") {
      const c = content as { id?: string; to?: string; subject?: string; date?: string; text?: string; purged?: boolean } | null;
      if (!c || !c.text) {
        st.skipped_purged += 1;
        db.run("UPDATE evidence SET purge_after = NULL WHERE id = ?", [String(r.id)]);
        return false;
      }
      const id = this.ensureEntry(`ent_${String(r.id)}`, {
        kind: "sent_mail",
        source: String(r.source),
        occurred_at: String(r.occurred_at),
        text: `To ${c.to ?? "?"} — "${c.subject ?? ""}"\n${c.text}`,
        meta: { to: c.to ?? null, subject: c.subject ?? null, message_id: c.id ?? null },
      });
      setRef({ entry_id: id, id: c.id ?? null, to: c.to ?? null, subject: c.subject ?? null, date: c.date ?? null });
      return true;
    }

    if (kind === "note") {
      const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
      const id = this.ensureEntry(`ent_${String(r.id)}`, {
        kind: "transcript",
        source: String(r.source),
        text,
        occurred_at: String(r.occurred_at),
        meta: { title: r.summary_enc ? cipher.decOpt(r.summary_enc as string) : null, backfilled: true },
      });
      setRef({ entry_id: id });
      return true;
    }

    if (kind === "answer") {
      const c = content as { question?: string; answer?: string } | null;
      const id = this.ensureEntry(`ent_${String(r.id)}`, {
        kind: "answer",
        source: "question",
        text: c?.answer ?? "",
        occurred_at: String(r.occurred_at),
        meta: { question: c?.question ?? null, backfilled: true },
      });
      setRef({ entry_id: id, question: c?.question ?? null });
      return true;
    }

    return false;
  }

  /** Copy item history into the log as change events. The item's own audit stays where it is. */
  private stepHistory(st: BackfillProgress): boolean {
    const { db, memory } = this.svc;
    if (st.cursor.hist_max == null) st.cursor.hist_max = this.histMaxAtBoot;
    const rows = db.all<Record<string, unknown>>("SELECT * FROM item_history WHERE id > ? AND id <= ? ORDER BY id LIMIT ?", [st.cursor.hist_id, st.cursor.hist_max, BATCH]);
    const titles = new Map<string, string>();
    for (const r of rows) {
      const itemId = String(r.item_id);
      if (!titles.has(itemId)) titles.set(itemId, this.svc.items.get(itemId)?.title ?? itemId);
      const oldV = r.old_value === null || r.old_value === undefined ? "—" : String(r.old_value);
      const newV = r.new_value === null || r.new_value === undefined ? "—" : String(r.new_value);
      const id = this.ensureEntry(`ent_h${String(r.id)}`, {
        kind: "item_event",
        source: "system",
        occurred_at: String(r.at),
        text: `${titles.get(itemId)} · ${String(r.field)}: ${oldV} → ${newV}`,
        meta: { item_id: itemId, history_id: r.id, field: r.field, old_value: r.old_value ?? null, new_value: r.new_value ?? null, via: r.via },
      });
      memory.link(id, "touched", "item", itemId);
      st.cursor.hist_id = Number(r.id);
      st.copied.history += 1;
    }
    if (rows.length < BATCH) {
      st.phase = "done";
      st.finished_at = this.svc.clock.now().toISOString();
      this.svc.log.info(
        "memory.backfill",
        `Raw log backfill complete: ${st.copied.turns} turns, ${st.copied.evidence} sourced entries, ${st.copied.history} item events copied${st.skipped_purged ? `; ${st.skipped_purged} previously purged records can't be recovered` : ""}`,
      );
    }
    memory.setState("backfill", st);
    return st.phase !== "done";
  }

  /** Deterministic-id append: an interrupted run never duplicates a copied entry. */
  private ensureEntry(id: string, e: Parameters<Services["memory"]["append"]>[0]): string {
    if (this.svc.db.get("SELECT id FROM entries WHERE id = ?", [id])) return id;
    return this.svc.memory.append({ ...e, id });
  }
}
