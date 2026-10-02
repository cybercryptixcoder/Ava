import { randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import type { Services } from "../core/services";
import type { GoogleAuth } from "./google";
import { readSource, writeSourceState } from "./state";
import { classifyEvent, removeMissing } from "./calendar-util";
import type { SourcePlugin } from "./types";

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string };
}

interface CalendarEntry {
  id: string;
  summary: string;
  primary?: boolean;
  selected?: boolean;
}

/**
 * Google Calendar, read-only. Each poll re-reads a rolling window
 * (two weeks back, ninety days ahead) and mirrors it into event items. Push
 * notifications (events.watch) trigger a sync when the public URL is https;
 * otherwise the heartbeat polls as a fallback.
 */
export class GoogleCalendarSource implements SourcePlugin {
  readonly id = "gcal";
  readonly label = "Google Calendar";
  readonly description = "Reads your calendars so Ava knows when you're busy, in class, or free.";
  readonly defaultOn = true;
  readonly pollEveryMinutes = 30;

  constructor(
    private svc: Services,
    private google: GoogleAuth,
  ) {}

  configured(): boolean {
    return this.google.configured();
  }
  needs(): string | null {
    if (!this.configured()) return "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET";
    if (!this.connected()) return "Connect your Google account";
    return null;
  }
  connected(): boolean {
    return this.google.hasScope("https://www.googleapis.com/auth/calendar.readonly");
  }

  async calendars(): Promise<CalendarEntry[]> {
    const r = await this.google.api<{ items: CalendarEntry[] }>("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250");
    return r.items ?? [];
  }

  selectedCalendarIds(): string[] {
    const s = readSource(this.svc, this.id).state as { calendars?: string[] };
    return s.calendars?.length ? s.calendars : ["primary"];
  }

  setCalendars(ids: string[]): void {
    const st = readSource(this.svc, this.id);
    writeSourceState(this.svc, this.id, { ...st.state, calendars: ids });
  }

  async poll(wakeId: string | null): Promise<string> {
    if (!this.connected()) return "not connected";
    const { items, clock, settings } = this.svc;
    const now = clock.now();
    const from = new Date(now.getTime() - 14 * 86_400_000).toISOString();
    const to = new Date(now.getTime() + 90 * 86_400_000).toISOString();
    const all = await this.calendars().catch(() => [] as CalendarEntry[]);
    const names = new Map(all.map((c) => [c.id, c.summary]));
    let created = 0,
      changed = 0;
    const seen = new Set<string>();
    for (const calId of this.selectedCalendarIds()) {
      let pageToken: string | undefined;
      do {
        const p = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: "true", orderBy: "startTime", maxResults: "2500", showDeleted: "true" });
        if (pageToken) p.set("pageToken", pageToken);
        const res = await this.google.api<{ items: GEvent[]; nextPageToken?: string }>(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${p}`);
        for (const e of res.items ?? []) {
          const ref = `${calId}:${e.id}`;
          if (e.status === "cancelled") {
            const ex = items.getBySourceRef("gcal", ref);
            if (ex && ex.status !== "cancelled") items.update(ex.id, { status: "cancelled" }, "gcal", { touch: false });
            continue;
          }
          const allDay = !!e.start?.date;
          const tz = settings.tz();
          const start = e.start?.dateTime ?? (e.start?.date ? DateTime.fromISO(e.start.date, { zone: tz }).toUTC().toISO() : null);
          const end = e.end?.dateTime ?? (e.end?.date ? DateTime.fromISO(e.end.date, { zone: tz }).toUTC().toISO() : null);
          if (!start) continue;
          seen.add(ref);
          const title = e.summary?.trim() || "(busy)";
          const r = items.upsertExternal("gcal", ref, {
            type: "event",
            title,
            status: e.status === "tentative" ? "tentative" : "confirmed",
            start_at: start,
            end_at: end,
            data: {
              kind: classifyEvent(title, e.description ?? "", names.get(calId) ?? ""),
              location: e.location,
              calendar: names.get(calId) ?? calId,
              all_day: allDay,
              busy: e.transparency !== "transparent" && !allDay,
            },
          });
          if (r.created) created++;
          else if (r.changed) changed++;
        }
        pageToken = res.nextPageToken;
      } while (pageToken);
    }
    const removed = removeMissing(this.svc, "gcal", seen, from, to);
    await this.ensureWatch().catch((e) => this.svc.log.warn("source.gcal_watch", `Calendar push notifications unavailable, polling instead: ${(e as Error).message}`));
    const summary = `${seen.size} events in window: ${created} new, ${changed} changed, ${removed} removed`;
    if (created + changed + removed > 0) this.svc.log.info("source.gcal", `Calendar synced: ${summary}`, undefined, wakeId);
    return summary;
  }

  /** Register a push channel for the primary calendar (needs an https PUBLIC_URL). */
  async ensureWatch(): Promise<void> {
    const { cfg, clock } = this.svc;
    if (!cfg.publicUrl.startsWith("https://")) return;
    const st = readSource(this.svc, this.id);
    const ch = st.state.channel as { id: string; resourceId: string; expiration: number; token: string } | null | undefined;
    if (ch && ch.expiration - clock.now().getTime() > 24 * 3_600_000) return;
    const token = randomBytes(16).toString("hex");
    const id = `ava-${randomBytes(8).toString("hex")}`;
    const res = await this.google.api<{ id: string; resourceId: string; expiration: string }>(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/watch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, type: "web_hook", address: `${cfg.publicUrl}/api/webhooks/gcal`, token, params: { ttl: String(7 * 86400) } }),
      },
    );
    writeSourceState(this.svc, this.id, { ...st.state, channel: { id: res.id, resourceId: res.resourceId, expiration: Number(res.expiration), token } });
    this.svc.log.info("source.gcal_watch", "Calendar push notifications registered");
  }

  /** Called from the webhook route. Returns true if the notification is ours. */
  verifyWebhook(channelId: string | undefined, token: string | undefined): boolean {
    const ch = readSource(this.svc, this.id).state.channel as { id: string; token: string } | null | undefined;
    return !!ch && ch.id === channelId && ch.token === token;
  }

  stats(): Record<string, number> {
    const r = this.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE source = 'gcal' AND deleted_at IS NULL");
    return { events: r?.n ?? 0 };
  }

  deleteData(): number {
    const n = this.svc.db.run("DELETE FROM items WHERE source = 'gcal'").changes;
    this.svc.evidence.deleteBySource("gcal");
    return n;
  }
}
