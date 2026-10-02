import type { Services } from "../core/services";
import { j, js } from "../db/db";
import type { SourceState } from "./types";

export function readSource(svc: Services, id: string): SourceState {
  const r = svc.db.get<{ state: string; last_sync_at: string | null; last_error: string | null }>("SELECT state, last_sync_at, last_error FROM sources WHERE id = ?", [id]);
  return { state: j(r?.state, {}), last_sync_at: r?.last_sync_at ?? null, last_error: r?.last_error ?? null };
}

export function writeSourceState(svc: Services, id: string, state: Record<string, unknown>, sync?: { ok: boolean; error?: string | null }): void {
  const now = svc.clock.now().toISOString();
  svc.db.run(
    `INSERT INTO sources (id, state, updated_at, last_sync_at, last_error) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at,
       last_sync_at = COALESCE(excluded.last_sync_at, sources.last_sync_at),
       last_error = CASE WHEN ? THEN excluded.last_error ELSE sources.last_error END`,
    [id, js(state), now, sync?.ok ? now : null, sync ? (sync.error ?? null) : null, sync ? 1 : 0],
  );
}

export function readSecrets<T>(svc: Services, id: string): T | null {
  const r = svc.db.get<{ secrets_enc: string | null }>("SELECT secrets_enc FROM sources WHERE id = ?", [id]);
  return r?.secrets_enc ? svc.cipher.decJson<T | null>(r.secrets_enc, null) : null;
}

export function writeSecrets(svc: Services, id: string, secrets: unknown | null): void {
  const now = svc.clock.now().toISOString();
  const enc = secrets === null ? null : svc.cipher.encJson(secrets);
  svc.db.run(
    "INSERT INTO sources (id, state, secrets_enc, updated_at) VALUES (?, '{}', ?, ?) ON CONFLICT(id) DO UPDATE SET secrets_enc = excluded.secrets_enc, updated_at = excluded.updated_at",
    [id, enc, now],
  );
}
