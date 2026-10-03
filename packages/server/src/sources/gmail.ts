import type { Services } from "../core/services";
import { extract } from "../conversation/extraction";
import type { GoogleAuth } from "./google";
import { readSource, writeSourceState } from "./state";
import type { SourcePlugin } from "./types";

interface GmailMessage {
  id: string;
  internalDate: string;
  payload: GmailPart & { headers: { name: string; value: string }[] };
}
interface GmailPart {
  mimeType: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function b64url(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

function plainText(p: GmailPart): string {
  if (p.mimeType === "text/plain" && p.body?.data) return b64url(p.body.data);
  for (const c of p.parts ?? []) {
    const t = plainText(c);
    if (t) return t;
  }
  if (p.mimeType === "text/html" && p.body?.data) return b64url(p.body.data).replace(/<[^>]+>/g, " ");
  return "";
}

/** Keep only what he wrote: drop quoted replies and signatures. */
export function ownWords(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  for (const l of lines) {
    if (/^On .+wrote:\s*$/.test(l) || /^-{2,}\s*Original Message/i.test(l) || /^From: /.test(l)) break;
    if (/^>/.test(l)) continue;
    if (/^--\s*$/.test(l)) break;
    out.push(l);
  }
  return out.join("\n").trim().slice(0, 4000);
}

/**
 * Gmail, sent mail only, for commitments. His own words ("I'll send it by
 * Friday") become commitments and follow-up triggers. Other people's
 * content isn't processed: only the recipient name a commitment needs.
 * Off by default.
 */
export class GmailSentSource implements SourcePlugin {
  readonly id = "gmail";
  readonly label = "Gmail (sent mail, commitments only)";
  readonly description = "Reads only mail you sent, to catch promises like \"I'll send it by Friday\". Nothing about other people beyond what the commitment needs.";
  readonly defaultOn = false;
  readonly pollEveryMinutes = 60;

  constructor(
    private svc: Services,
    private google: GoogleAuth,
  ) {}

  configured(): boolean {
    return this.google.configured();
  }
  needs(): string | null {
    if (!this.configured()) return "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET";
    if (!this.connected()) return "Connect Gmail";
    return null;
  }
  connected(): boolean {
    return this.google.hasScope("https://www.googleapis.com/auth/gmail.readonly");
  }
  canSend(): boolean {
    return this.google.hasScope("https://www.googleapis.com/auth/gmail.send");
  }

  async poll(wakeId: string | null): Promise<string> {
    if (!this.connected()) return "not connected";
    const { clock, evidence, proposals, log, models } = this.svc;
    const st = readSource(this.svc, this.id);
    const since = Number(st.state.since ?? Math.floor((clock.now().getTime() - 14 * 86_400_000) / 1000));
    const list = await this.google.api<{ messages?: { id: string }[] }>(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(`in:sent after:${since}`)}&maxResults=50`);
    let newest = since;
    const emails: { id: string; to: string; subject: string; date: string; text: string }[] = [];
    for (const m of list.messages ?? []) {
      const full = await this.google.api<GmailMessage>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`);
      const h = (n: string) => full.payload.headers.find((x) => x.name.toLowerCase() === n)?.value ?? "";
      const text = ownWords(plainText(full.payload));
      newest = Math.max(newest, Math.floor(Number(full.internalDate) / 1000));
      if (text.length < 20) continue;
      // Recipient display name only, never addresses of third parties in the stored summary.
      const to = h("to").replace(/<[^>]+>/g, "").split(",")[0].trim();
      emails.push({ id: m.id, to, subject: h("subject"), date: new Date(Number(full.internalDate)).toISOString(), text });
    }
    let made = 0;
    const entryByRef = new Map<string, string>();
    for (const e of emails) {
      // His sent words go into the raw log permanently; evidence keeps the reference.
      const entryId = this.svc.memory.append({
        kind: "sent_mail",
        source: this.id,
        occurred_at: e.date,
        text: `To ${e.to} — "${e.subject}"\n${e.text}`,
        meta: { to: e.to, subject: e.subject, message_id: e.id },
      });
      entryByRef.set(e.id, entryId);
    }
    if (emails.length && models.available) {
      const evIds = emails.map((e) =>
        evidence.add({ kind: "email", source: this.id, source_ref: e.id, occurred_at: e.date, summary: `Sent to ${e.to}: ${e.subject}`, content: { entry_id: entryByRef.get(e.id)!, id: e.id, to: e.to, subject: e.subject, date: e.date } }),
      );
      const text = emails.map((e) => `### To ${e.to} — "${e.subject}" (${e.date.slice(0, 10)})\n${e.text}`).join("\n\n");
      const changes = await extract(this.svc, text, {
        purpose: "gmail.extract",
        origin: "system",
        extraInstruction:
          "These are emails Shreyas sent. Extract only commitments he made in his own words (\"I'll send it by Friday\", \"I'll get back to you next week\") as commitments with to_person set to the recipient's name and a due date if stated. Ignore everything else, including anything about the recipients themselves.",
      });
      const commitments = changes.filter((c) => c.change.op === "create_item" && ["commitment", "open_loop"].includes(c.change.item.type));
      if (commitments.length) made = proposals.createBatch(this.id, commitments.map((c) => ({ ...c, evidence_id: evIds[0] }))).proposals.length;
      for (const id of evIds) evidence.markDistilled(id);
    }
    writeSourceState(this.svc, this.id, { ...st.state, since: newest + 1 }, { ok: true });
    const summary = `${emails.length} sent emails read, ${made} commitments proposed`;
    if (emails.length) log.info("source.gmail", summary, undefined, wakeId);
    return summary;
  }

  /** Called only by ExternalActions.confirm, after Shreyas confirms the exact message. */
  async send(p: { to: string; subject: string; body: string }): Promise<string> {
    if (!this.canSend()) throw new Error("Gmail send access isn't granted");
    const raw = [`To: ${p.to}`, `Subject: ${p.subject}`, "Content-Type: text/plain; charset=UTF-8", "MIME-Version: 1.0", "", p.body].join("\r\n");
    const r = await this.google.api<{ id: string }>("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url") }),
    });
    return `Gmail message id ${r.id}`;
  }

  stats(): Record<string, number> {
    const e = this.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM evidence WHERE source = ?", [this.id])?.n ?? 0;
    return { emails_read: e, to_review: this.svc.proposals.pendingCountByOrigin()[this.id] ?? 0 };
  }

  deleteData(): number {
    this.svc.db.run("DELETE FROM proposals WHERE origin = ? AND status = 'pending'", [this.id]);
    writeSourceState(this.svc, this.id, {});
    this.svc.memory.forgetBySource(this.id, "you deleted the Gmail source data");
    return this.svc.evidence.deleteBySource(this.id);
  }
}
