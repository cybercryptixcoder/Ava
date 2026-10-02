import type { ExternalActionView } from "@ava/shared";
import type { Services } from "../core/services";
import { newId } from "../db/db";

interface EmailPayload {
  to: string;
  subject: string;
  body: string;
}

/**
 * External actions (sending email, and anything else that leaves Ava) need
 * Shreyas's explicit confirmation every single time, showing exactly what
 * will be sent and to whom. There is no "always allow". Rules, the planner
 * and executors can only create a pending action; only the confirm endpoint,
 * called from the interface with the exact payload he saw, executes it.
 */
export class ExternalActions {
  constructor(private svc: Services) {}

  private availability(): { available: boolean; reason: string | null } {
    const { cfg, sources } = this.svc;
    if (!cfg.google.clientId || !cfg.google.gmailSend) return { available: false, reason: "Sending is off. Set GMAIL_SEND_ENABLED=true and reconnect Google in Settings." };
    if (!sources.gmailCanSend()) return { available: false, reason: "Reconnect Google in Settings to grant send access." };
    return { available: true, reason: null };
  }

  private row(r: Record<string, unknown>): ExternalActionView {
    const payload = this.svc.cipher.decJson<EmailPayload>(r.payload_enc as string, { to: "", subject: "", body: "" });
    const a = this.availability();
    return {
      id: String(r.id),
      kind: "email.send",
      status: r.status as ExternalActionView["status"],
      preview: payload,
      artifact_id: (r.artifact_id as string) ?? null,
      created_at: String(r.created_at),
      result: (r.result as string) ?? null,
      available: a.available,
      unavailable_reason: a.reason,
    };
  }

  prepareEmail(payload: EmailPayload, artifactId: string | null): ExternalActionView {
    const { db, cipher, clock, log } = this.svc;
    const id = newId("ext");
    db.run("INSERT INTO external_actions (id, kind, payload_enc, status, artifact_id, created_at) VALUES (?, 'email.send', ?, 'pending', ?, ?)", [
      id,
      cipher.encJson(payload),
      artifactId,
      clock.now().toISOString(),
    ]);
    log.info("action.prepared", `Email to ${payload.to} prepared; waiting for your confirmation`, { action_id: id });
    return this.get(id)!;
  }

  get(id: string): ExternalActionView | null {
    const r = this.svc.db.get("SELECT * FROM external_actions WHERE id = ?", [id]);
    return r ? this.row(r) : null;
  }

  pending(): ExternalActionView[] {
    return this.svc.db.all("SELECT * FROM external_actions WHERE status = 'pending' ORDER BY created_at DESC").map((r) => this.row(r));
  }

  list(limit = 50): ExternalActionView[] {
    return this.svc.db.all("SELECT * FROM external_actions ORDER BY created_at DESC LIMIT ?", [limit]).map((r) => this.row(r));
  }

  /** Edit before confirming (he may fix the draft). */
  edit(id: string, payload: EmailPayload): ExternalActionView {
    const a = this.get(id);
    if (!a || a.status !== "pending") throw new Error("Only pending actions can be edited");
    this.svc.db.run("UPDATE external_actions SET payload_enc = ? WHERE id = ?", [this.svc.cipher.encJson(payload), id]);
    return this.get(id)!;
  }

  /** Execute, but only if the confirmed payload is exactly what is stored. */
  async confirm(id: string, shown: EmailPayload): Promise<ExternalActionView> {
    const { db, clock, log, sources } = this.svc;
    const a = this.get(id);
    if (!a) throw new Error(`No action ${id}`);
    if (a.status !== "pending") throw new Error(`This action is already ${a.status}`);
    if (a.preview.to !== shown.to || a.preview.subject !== shown.subject || a.preview.body !== shown.body) {
      throw new Error("The message changed since you looked at it. Review it again before sending.");
    }
    const avail = this.availability();
    if (!avail.available) throw new Error(avail.reason ?? "Sending isn't available");
    db.run("UPDATE external_actions SET status = 'confirmed', confirmed_at = ? WHERE id = ?", [clock.now().toISOString(), id]);
    log.info("action.confirmed", `You confirmed sending email to ${a.preview.to}: "${a.preview.subject}"`, { action_id: id });
    try {
      const result = await sources.gmailSend(a.preview);
      db.run("UPDATE external_actions SET status = 'executed', executed_at = ?, result = ? WHERE id = ?", [clock.now().toISOString(), result, id]);
      log.info("action.executed", `Sent email to ${a.preview.to}`, { action_id: id, result });
    } catch (e) {
      db.run("UPDATE external_actions SET status = 'failed', result = ? WHERE id = ?", [(e as Error).message, id]);
      log.error("action.failed", `Sending to ${a.preview.to} failed: ${(e as Error).message}`, { action_id: id });
    }
    this.svc.bus.emit({ type: "state.changed", what: ["actions"] });
    return this.get(id)!;
  }

  cancel(id: string): ExternalActionView {
    this.svc.db.run("UPDATE external_actions SET status = 'cancelled' WHERE id = ? AND status = 'pending'", [id]);
    this.svc.log.info("action.cancelled", "You cancelled a pending external action", { action_id: id });
    return this.get(id)!;
  }
}
