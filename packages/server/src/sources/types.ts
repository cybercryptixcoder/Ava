/**
 * The common source-plugin interface. Every data source is one of these,
 * with its own on/off switch in Settings. Adding a source means
 * implementing this and registering it in sources/hub.ts.
 */
export interface SourcePlugin {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly defaultOn: boolean;
  /** Keys/config present for this source to work. */
  configured(): boolean;
  /** What's missing, in plain words, or null. */
  needs(): string | null;
  /** Authorized/connected (for OAuth sources). */
  connected(): boolean;
  /** Minimum minutes between polls; undefined means the source never polls. */
  readonly pollEveryMinutes?: number;
  /** Pull changes since the last sync. Returns a short human summary. */
  poll?(wakeId: string | null): Promise<string>;
  stats(): Record<string, number>;
  /** Delete everything this source contributed. Returns rows removed. */
  deleteData(): number;
}

export interface SourceState {
  state: Record<string, unknown>;
  last_sync_at: string | null;
  last_error: string | null;
}
