import fs from "node:fs";
import path from "node:path";
import type { WordTiming } from "@ava/shared";
import type { Services } from "../core/services";
import { j, js, newId } from "../db/db";

/**
 * Audio on disk, encrypted at rest. Spoken replies and uploaded recordings
 * are both deleted after the configured retention period.
 */
export class AudioStore {
  constructor(private svc: Services) {}

  private dir(): string {
    fs.mkdirSync(this.svc.cfg.audioDir, { recursive: true });
    return this.svc.cfg.audioDir;
  }

  save(audio: Buffer, mime: string, kind: "tts" | "upload" | "audition", timings: { words: WordTiming[]; cues?: unknown } | null = null): string {
    const { db, cipher, clock, settings } = this.svc;
    const id = newId("aud");
    const file = path.join(this.dir(), `${id}.bin`);
    fs.writeFileSync(file, cipher.encryptBuffer(audio));
    const days = kind === "audition" ? 3650 : settings.get().retention.raw_audio_days;
    db.run("INSERT INTO audio_files (id, path, kind, mime, timings, created_at, purge_after) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      id,
      file,
      kind,
      mime,
      timings ? js(timings) : null,
      clock.now().toISOString(),
      new Date(clock.now().getTime() + days * 86_400_000).toISOString(),
    ]);
    return id;
  }

  load(id: string): { audio: Buffer; mime: string; timings: { words: WordTiming[]; cues?: unknown } | null } | null {
    const r = this.svc.db.get<{ path: string; mime: string; timings: string | null }>("SELECT path, mime, timings FROM audio_files WHERE id = ?", [id]);
    if (!r || !fs.existsSync(r.path)) return null;
    return { audio: this.svc.cipher.decryptBuffer(fs.readFileSync(r.path)), mime: r.mime, timings: j(r.timings, null) };
  }

  purgeDue(now: Date): number {
    const rows = this.svc.db.all<{ id: string; path: string }>("SELECT id, path FROM audio_files WHERE purge_after <= ?", [now.toISOString()]);
    for (const r of rows) {
      try {
        fs.rmSync(r.path, { force: true });
      } catch {
        /* already gone */
      }
      this.svc.db.run("DELETE FROM audio_files WHERE id = ?", [r.id]);
    }
    return rows.length;
  }
}
