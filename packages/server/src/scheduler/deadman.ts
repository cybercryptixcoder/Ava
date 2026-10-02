import { inQuietHours, wakingMsBetween } from "@ava/shared";
import type { Services } from "../core/services";

/**
 * The dead-man's switch is system-owned: if no wake has completed
 * successfully in N waking hours (default 6), send a plain alert. Ava has no
 * way to cancel or reconfigure it. An external ping URL (optional) covers
 * the case where the whole process is down.
 */
export class DeadmanSwitch {
  private timer: NodeJS.Timeout | null = null;
  private bootAt: Date;

  constructor(private svc: Services) {
    this.bootAt = svc.clock.now();
  }

  start(): void {
    if (this.svc.clock.simulated) return;
    this.timer = setInterval(() => void this.check(), 10 * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private key = "deadman.alerted_for";

  async check(): Promise<boolean> {
    const { scheduler, settings, clock, db, log, channels } = this.svc;
    const s = settings.get();
    const tz = settings.tz();
    const now = clock.now();
    if (inQuietHours(now, tz, s.quiet_hours.start, s.quiet_hours.end)) return false;
    const last = scheduler.lastSuccessfulWake();
    const since = last?.finished_at ? new Date(last.finished_at) : this.bootAt;
    const waking = wakingMsBetween(since, now, tz, s.quiet_hours.start, s.quiet_hours.end);
    if (waking < s.deadman_waking_hours * 3_600_000) return false;
    const marker = last?.id ?? `boot:${this.bootAt.toISOString()}`;
    const prev = db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [this.key]);
    if (prev?.value === marker) return false;
    db.run(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [this.key, marker, now.toISOString()],
    );
    const hours = Math.round((waking / 3_600_000) * 10) / 10;
    log.error("deadman.alert", `No wake has completed in ${hours} waking hours. Sent a plain alert.`, { last_wake: last?.id ?? null });
    await channels.alert("Ava hasn't run in a while", `No wake has completed successfully in ${hours} waking hours. Open the Log to see what failed.`);
    return true;
  }
}
