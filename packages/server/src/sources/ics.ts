import ical, { type VEvent } from "node-ical";
import type { Services } from "../core/services";
import { newId } from "../db/db";
import { classifyEvent, courseOf, deadlineKind, removeMissing } from "./calendar-util";
import type { SourcePlugin } from "./types";

type PV = string | { val: string } | undefined;
const pv = (v: PV): string => (typeof v === "string" ? v : (v?.val ?? ""));

export interface IcsFeedView {
  id: string;
  label: string;
  kind: "course" | "other";
  enabled: boolean;
  last_fetch_at: string | null;
  last_error: string | null;
  url_hint: string;
}

/**
 * ICS feeds, for course calendars. Recurring events are expanded over a
 * rolling window. In course feeds, zero-length items that look like
 * deadlines ("HW 4 due", "Quiz 3") become tasks; exams also get a prep task.
 */
export class IcsSource implements SourcePlugin {
  readonly id = "ics";
  readonly label = "Calendar feeds (ICS)";
  readonly description = "Course calendars and other subscribed .ics feeds. Paste a feed URL below.";
  readonly defaultOn = true;
  readonly pollEveryMinutes = 180;

  constructor(private svc: Services) {}

  configured(): boolean {
    return true;
  }
  needs(): string | null {
    return this.feeds().length ? null : "Add a feed URL";
  }
  connected(): boolean {
    return this.feeds().some((f) => f.enabled);
  }

  feeds(): IcsFeedView[] {
    return this.svc.db
      .all<{ id: string; label: string; kind: "course" | "other"; enabled: number; last_fetch_at: string | null; last_error: string | null; url_enc: string }>("SELECT * FROM ics_feeds ORDER BY created_at")
      .map((f) => {
        const url = this.svc.cipher.decOpt(f.url_enc) ?? "";
        let host = "";
        try {
          host = new URL(url.replace(/^webcal:/, "https:")).host;
        } catch {
          host = "invalid URL";
        }
        return { id: f.id, label: f.label, kind: f.kind, enabled: !!f.enabled, last_fetch_at: f.last_fetch_at, last_error: f.last_error, url_hint: host };
      });
  }

  async addFeed(url: string, label: string, kind: "course" | "other"): Promise<{ feed: IcsFeedView; summary: string }> {
    const norm = url.trim().replace(/^webcal:\/\//i, "https://");
    new URL(norm);
    const id = newId("ics");
    this.svc.db.run("INSERT INTO ics_feeds (id, label, url_enc, kind, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)", [
      id,
      label.trim() || "Feed",
      this.svc.cipher.encrypt(norm),
      kind,
      this.svc.clock.now().toISOString(),
    ]);
    const summary = await this.syncFeed(id, null);
    // A new course calendar is genuinely new context worth a planning session.
    if (kind === "course") this.svc.planner.requestNewContext(`a new course calendar feed, "${label}"`);
    return { feed: this.feeds().find((f) => f.id === id)!, summary };
  }

  removeFeed(id: string): void {
    this.svc.db.run("DELETE FROM items WHERE source = ?", [`ics:${id}`]);
    this.svc.db.run("DELETE FROM ics_feeds WHERE id = ?", [id]);
  }

  setFeedEnabled(id: string, enabled: boolean): void {
    this.svc.db.run("UPDATE ics_feeds SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, id]);
  }

  async poll(wakeId: string | null): Promise<string> {
    const parts: string[] = [];
    for (const f of this.feeds().filter((x) => x.enabled)) parts.push(`${f.label}: ${await this.syncFeed(f.id, wakeId)}`);
    return parts.join("; ") || "no feeds";
  }

  /** Parse and mirror one feed. Exposed for tests with a body instead of a fetch. */
  async syncFeed(id: string, wakeId: string | null, bodyOverride?: string): Promise<string> {
    const { db, cipher, clock, items, log } = this.svc;
    const f = db.get<{ url_enc: string; label: string; kind: "course" | "other"; etag: string | null }>("SELECT * FROM ics_feeds WHERE id = ?", [id]);
    if (!f) return "feed missing";
    const source = `ics:${id}`;
    try {
      let body = bodyOverride;
      if (!body) {
        const url = cipher.decrypt(f.url_enc);
        const res = await fetch(url, { headers: f.etag ? { "if-none-match": f.etag } : {}, signal: AbortSignal.timeout(20_000) });
        if (res.status === 304) {
          db.run("UPDATE ics_feeds SET last_fetch_at = ?, last_error = NULL WHERE id = ?", [clock.now().toISOString(), id]);
          return "unchanged";
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        body = await res.text();
        db.run("UPDATE ics_feeds SET etag = ? WHERE id = ?", [res.headers.get("etag"), id]);
      }
      const parsed = ical.sync.parseICS(body);
      const now = clock.now();
      const from = new Date(now.getTime() - 14 * 86_400_000);
      const to = new Date(now.getTime() + 120 * 86_400_000);
      const seen = new Set<string>();
      let created = 0,
        changed = 0;
      for (const comp of Object.values(parsed)) {
        if (!comp || (comp as { type?: string }).type !== "VEVENT") continue;
        const ev = comp as VEvent;
        const instances = ical.expandRecurringEvent(ev, { from, to });
        for (const inst of instances) {
          const title = pv(inst.summary as PV).trim() || "(untitled)";
          const desc = pv(inst.event.description as PV);
          const start = new Date(inst.start);
          const end = inst.end ? new Date(inst.end) : start;
          const minutes = (end.getTime() - start.getTime()) / 60_000;
          const ref = `${ev.uid}:${start.toISOString()}`;
          const dk = deadlineKind(title, desc);
          const course = courseOf(title) ?? (f.kind === "course" ? f.label : null);
          const isDeadline = !!dk && (minutes <= 30 || inst.isFullDay) && f.kind === "course";
          if (isDeadline) {
            // A deadline: the due moment is the end of a full-day item or the stated time.
            const due = inst.isFullDay ? new Date(end.getTime() - 60_000) : start;
            seen.add(`${ref}:task`);
            const r = items.upsertExternal(source, `${ref}:task`, { type: "task", title, due_at: due.toISOString(), data: { kind: dk, course: course ?? undefined }, tags: course ? [course] : [] });
            if (r.created) {
              created++;
              this.svc.scheduler.syncDeadlineWakes(r.item);
            } else if (r.changed) changed++;
            continue;
          }
          const kind = classifyEvent(title, desc, f.label, f.kind);
          seen.add(ref);
          const r = items.upsertExternal(source, ref, {
            type: "event",
            title,
            status: pv(inst.event.status as PV).toLowerCase() === "cancelled" ? "cancelled" : "confirmed",
            start_at: start.toISOString(),
            end_at: end.toISOString(),
            data: { kind, location: pv(inst.event.location as PV) || undefined, calendar: f.label, all_day: inst.isFullDay, busy: !inst.isFullDay },
          });
          if (r.created) created++;
          else if (r.changed) changed++;
          if (kind === "exam" && start > now) {
            seen.add(`${ref}:prep`);
            const p = items.upsertExternal(source, `${ref}:prep`, {
              type: "task",
              title: `Prepare for ${title}`,
              due_at: start.toISOString(),
              data: { kind: /quiz/i.test(title) ? "quiz" : "exam", course: course ?? undefined },
              tags: course ? [course] : [],
            });
            if (p.created) this.svc.scheduler.syncDeadlineWakes(p.item);
          }
        }
      }
      const removed = removeMissing(this.svc, source, seen, from.toISOString(), to.toISOString());
      db.run("UPDATE ics_feeds SET last_fetch_at = ?, last_error = NULL WHERE id = ?", [clock.now().toISOString(), id]);
      const summary = `${seen.size} entries: ${created} new, ${changed} changed, ${removed} removed`;
      if (created + changed + removed) log.info("source.ics", `${f.label} synced: ${summary}`, undefined, wakeId);
      return summary;
    } catch (e) {
      db.run("UPDATE ics_feeds SET last_fetch_at = ?, last_error = ? WHERE id = ?", [clock.now().toISOString(), (e as Error).message, id]);
      log.warn("source.ics_failed", `${f.label} failed to sync: ${(e as Error).message}`, undefined, wakeId);
      return `failed: ${(e as Error).message}`;
    }
  }

  stats(): Record<string, number> {
    const r = this.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE source LIKE 'ics:%' AND deleted_at IS NULL");
    return { feeds: this.feeds().length, items: r?.n ?? 0 };
  }

  deleteData(): number {
    return this.svc.db.run("DELETE FROM items WHERE source LIKE 'ics:%'").changes;
  }
}
