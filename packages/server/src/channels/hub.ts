import webpush from "web-push";
import type { Services } from "../core/services";
import { newId } from "../db/db";

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  card_id?: string;
  actions?: { action: string; title: string }[];
  silent?: boolean;
}

/** A way to reach Shreyas. Web push is the first; others (SMS, Telegram) can implement this later. */
export interface Channel {
  readonly id: string;
  available(): boolean;
  send(payload: PushPayload): Promise<{ delivered: number; failed: number }>;
}

class WebPushChannel implements Channel {
  readonly id = "webpush";
  constructor(private svc: Services) {
    const { vapid } = svc.cfg;
    if (vapid.publicKey && vapid.privateKey) webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  }

  available(): boolean {
    return !!(this.svc.cfg.vapid.publicKey && this.svc.cfg.vapid.privateKey);
  }

  async send(payload: PushPayload): Promise<{ delivered: number; failed: number }> {
    const { db, cipher, log, clock } = this.svc;
    const subs = db.all<{ id: string; endpoint: string; keys_enc: string; failures: number }>("SELECT id, endpoint, keys_enc, failures FROM push_subscriptions");
    let delivered = 0,
      failed = 0;
    for (const s of subs) {
      const keys = cipher.decJson<{ p256dh: string; auth: string } | null>(s.keys_enc, null);
      if (!keys) continue;
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys }, JSON.stringify(payload), { TTL: 60 * 60 * 6, urgency: "high" });
        db.run("UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE id = ?", [clock.now().toISOString(), s.id]);
        delivered++;
      } catch (e) {
        failed++;
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410 || s.failures >= 5) {
          db.run("DELETE FROM push_subscriptions WHERE id = ?", [s.id]);
          log.warn("push.subscription_removed", `Removed an expired push subscription (${status ?? "repeated failures"})`);
        } else {
          db.run("UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?", [s.id]);
          log.warn("push.failed", `Push delivery failed: ${(e as Error).message}`);
        }
      }
    }
    return { delivered, failed };
  }
}

/**
 * Delivers messages on every available channel. Messages always appear in
 * the app as well (they are rows in the messages table, streamed over SSE).
 */
export class ChannelHub {
  private channels: Channel[];

  constructor(private svc: Services) {
    this.channels = [new WebPushChannel(svc)];
  }

  register(c: Channel): void {
    this.channels.push(c);
  }

  available(): string[] {
    return this.channels.filter((c) => c.available()).map((c) => c.id);
  }

  subscribe(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent: string | null): void {
    const { db, cipher, clock } = this.svc;
    db.run(
      "INSERT INTO push_subscriptions (id, endpoint, keys_enc, user_agent, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET keys_enc = excluded.keys_enc, user_agent = excluded.user_agent, failures = 0",
      [newId("psh"), sub.endpoint, cipher.encJson(sub.keys), userAgent, clock.now().toISOString()],
    );
  }

  unsubscribe(endpoint: string): void {
    this.svc.db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
  }

  subscriptions(): { id: string; user_agent: string | null; created_at: string; last_ok_at: string | null }[] {
    return this.svc.db.all("SELECT id, user_agent, created_at, last_ok_at FROM push_subscriptions ORDER BY created_at DESC");
  }

  private async broadcast(payload: PushPayload, wakeId: string | null = null): Promise<void> {
    if (this.svc.clock.simulated) {
      this.svc.log.info("push.simulated", `(simulated) push: ${payload.title}`, { payload }, wakeId);
      return;
    }
    for (const c of this.channels) {
      if (!c.available()) continue;
      const r = await c.send(payload);
      this.svc.log.info("push.delivered", `${c.id}: "${payload.title}" to ${r.delivered} device${r.delivered === 1 ? "" : "s"}${r.failed ? `, ${r.failed} failed` : ""}`, { tag: payload.tag }, wakeId);
    }
  }

  /** A time-sensitive card: just its one line, with "yes" and "not now" where the platform shows actions. */
  async pushCard(c: { card_id: string; title: string; yes: string }, wakeId: string | null = null): Promise<void> {
    await this.broadcast(
      {
        title: c.title,
        body: "",
        tag: c.card_id,
        url: `/?card=${c.card_id}`,
        card_id: c.card_id,
        // Browsers show at most two actions; long-press and voice reach the rest in the app.
        actions: [
          { action: "yes", title: c.yes.length > 24 ? "Yes" : c.yes },
          { action: "not_now", title: "Not now" },
        ],
      },
      wakeId,
    );
  }

  async notify(title: string, body: string, url: string, tag: string, wakeId: string | null = null): Promise<void> {
    await this.broadcast({ title, body, url, tag }, wakeId);
  }

  /** System alerts (dead-man's switch) are plain: no rule, no options. */
  async alert(title: string, body: string): Promise<void> {
    const { messages } = this.svc;
    const m = messages.create({
      kind: "alert",
      rule_id: null,
      wake_id: null,
      headline: title,
      because: body,
      cited: [],
      options: [],
      urgency: "now",
      status: "sent",
      drafted_by: "system",
    });
    await this.broadcast({ title, body, url: "/log", tag: m.id });
  }
}
