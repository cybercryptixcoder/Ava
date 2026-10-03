import type { Services } from "./services";

/**
 * Retention: raw high-volume data (activity window titles, raw audio, model
 * call bodies, old snapshots) is deleted after a short configurable period
 * once distilled. Text records of his words and Ava's replies — turns,
 * transcripts, imports, sent mail, artifacts — are the memory: they are
 * never purged. Distilled sessions and beliefs stay.
 */
export function runRetention(svc: Services): Record<string, number> {
  const { db, clock, settings, evidence, audio, log } = svc;
  const now = clock.now();
  const r = settings.get().retention;
  const before = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const out = {
    evidence_purged: evidence.purgeDue(now),
    audio_purged: audio.purgeDue(now),
    // Titles go once labeled and past their retention date; if they can't be labeled (no model key),
    // they go anyway at twice the retention period, so raw titles never accumulate.
    activity_titles: db.run(
      "UPDATE activity_sessions SET title_enc = NULL WHERE title_enc IS NOT NULL AND ((labeled_at IS NOT NULL AND purge_title_after <= ?) OR started_at < ?)",
      [now.toISOString(), before(r.raw_activity_days * 2)],
    ).changes,
    model_io: db.run("UPDATE model_calls SET input_enc = NULL, output_enc = NULL WHERE at < ? AND input_enc IS NOT NULL", [before(r.model_io_days)]).changes,
    snapshots: db.run("DELETE FROM snapshots WHERE at < ?", [before(r.snapshots_days)]).changes,
    canvas_events: db.run("DELETE FROM canvas_events WHERE consumed = 1 AND at < ?", [before(30)]).changes,
  };
  const total = Object.values(out).reduce((a, b) => a + b, 0);
  if (total) log.info("retention", `Retention removed raw data: ${Object.entries(out).filter(([, v]) => v).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ")}`);
  return out;
}

/** Everything Ava knows about Shreyas, decrypted, as one JSON document. */
export function exportEverything(svc: Services): Record<string, unknown> {
  const { db, items, beliefs, rules, messages, evidence } = svc;
  return {
    exported_at: svc.clock.now().toISOString(),
    profile: svc.cfg.profile,
    settings: svc.settings.get(),
    items: items.list({}),
    item_history: db.all("SELECT * FROM item_history ORDER BY id"),
    beliefs: beliefs.list({}),
    proposals: db.all("SELECT * FROM proposals ORDER BY created_at"),
    rules: rules.list(),
    messages: messages.list({ limit: 100000 }),
    plans: db.all("SELECT * FROM plans ORDER BY created_at"),
    questions: db.all("SELECT * FROM questions ORDER BY created_at"),
    evidence: evidence.list({ limit: 100000 }),
    entries: svc.memory.list({ limit: 100000, includeDeleted: true }),
    style_notes: db.all("SELECT * FROM style_notes"),
    activity_sessions: db.all("SELECT id, device, app, label, category, started_at, ended_at, active_seconds, item_id FROM activity_sessions ORDER BY started_at"),
    artifacts: db.all<{ id: string }>("SELECT id FROM artifacts").map((a) => svc.executors.artifact(a.id)),
    log: db.all("SELECT * FROM log ORDER BY id"),
  };
}
