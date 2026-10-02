/**
 * Merging raw samples into sessions, on the laptop. Raw samples live only in
 * memory for the length of one session; what leaves the machine is a
 * session: app, (optionally) a cleaned window title, start, end and active
 * seconds.
 */

export interface Sample {
  at: number; // epoch ms
  app: string;
  title: string;
  idle: boolean;
}

export interface Session {
  app: string;
  title?: string;
  started_at: string;
  ended_at: string;
  active_seconds: number;
}

export interface MergeOptions {
  intervalSeconds: number;
  /** A gap longer than this (sleep, collector paused) closes the session. */
  maxGapSeconds: number;
  /** Sessions shorter than this are alt-tab noise and are dropped. */
  minActiveSeconds: number;
  /** Long sessions are cut at this length so they arrive while still going. */
  maxSessionMinutes: number;
  sendTitles: boolean;
  /** Apps whose titles are never sent (password managers and the like). */
  privateApps: string[];
}

export const DEFAULT_PRIVATE_APPS = ["1Password", "Bitwarden", "KeePassXC", "Keychain Access", "LastPass", "Dashlane", "Proton Pass"];
const PRIVATE_TITLE = /\b(private browsing|incognito|inprivate)\b/i;

/** Window titles carry noise ("— Google Chrome", unread counts); keep the part that says what it is. */
export function cleanTitle(app: string, title: string, opts: Pick<MergeOptions, "sendTitles" | "privateApps">): string | undefined {
  if (!opts.sendTitles) return undefined;
  if (opts.privateApps.some((p) => app.toLowerCase().includes(p.toLowerCase()))) return undefined;
  if (PRIVATE_TITLE.test(title)) return undefined;
  let t = title
    .replace(/^\(\d+\)\s*/, "")
    .replace(/\s+[-–—|]\s+(Google Chrome|Chromium|Mozilla Firefox|Firefox|Safari|Microsoft Edge|Brave|Arc|Visual Studio Code|Code)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > 300) t = `${t.slice(0, 297)}...`;
  return t || undefined;
}

export class Merger {
  private current: { app: string; title: string; start: number; last: number; active: number } | null = null;
  private done: Session[] = [];

  constructor(private opts: MergeOptions) {}

  /**
   * Feed one sample. Each active sample stands for one interval of use.
   * Idle samples close the session (idle time is not a session); so do a
   * long gap (sleep), a change of app or title, and the length cap.
   */
  add(s: Sample): void {
    const step = this.opts.intervalSeconds * 1000;
    const c = this.current;
    if (c) {
      if ((s.at - c.last) / 1000 > this.opts.maxGapSeconds) this.close(c.last + step);
      else if (s.idle || c.app !== s.app || c.title !== s.title || s.at - c.start >= this.opts.maxSessionMinutes * 60_000) this.close(s.at);
    }
    if (s.idle) return;
    if (!this.current) this.current = { app: s.app, title: s.title, start: s.at, last: s.at, active: 0 };
    this.current.active += this.opts.intervalSeconds;
    this.current.last = s.at;
  }

  /** Close whatever is open (on idle, sleep or shutdown). */
  close(at: number = this.current ? this.current.last + this.opts.intervalSeconds * 1000 : Date.now()): void {
    const c = this.current;
    this.current = null;
    if (!c) return;
    const active = Math.round(c.active);
    if (active < this.opts.minActiveSeconds) return;
    this.done.push({
      app: c.app,
      title: cleanTitle(c.app, c.title, this.opts),
      started_at: new Date(c.start).toISOString(),
      ended_at: new Date(Math.max(at, c.last)).toISOString(),
      active_seconds: active,
    });
  }

  /** Closed sessions, removed from the merger. */
  take(): Session[] {
    const out = this.done;
    this.done = [];
    return out;
  }

  get open(): boolean {
    return this.current !== null;
  }
}
