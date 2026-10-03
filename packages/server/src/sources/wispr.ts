import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Services } from "../core/services";
import { extract } from "../conversation/extraction";
import { readSecrets, readSource, writeSecrets, writeSourceState } from "./state";
import type { SourcePlugin } from "./types";

interface WisprSecrets {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
}

/** OAuth client provider for Wispr Flow's official remote MCP server, storing everything encrypted. */
class WisprOAuth implements OAuthClientProvider {
  pendingAuthUrl: string | null = null;

  constructor(private svc: Services) {}

  private read(): WisprSecrets {
    return readSecrets<WisprSecrets>(this.svc, "wispr") ?? {};
  }
  private write(patch: Partial<WisprSecrets>) {
    writeSecrets(this.svc, "wispr", { ...this.read(), ...patch });
  }

  get redirectUrl(): string {
    return `${this.svc.cfg.publicUrl}/api/oauth/wispr/callback`;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Ava (personal agent)",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() {
    return this.read().client;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.write({ client: info });
  }
  tokens() {
    return this.read().tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.write({ tokens });
  }
  redirectToAuthorization(url: URL) {
    this.pendingAuthUrl = url.toString();
  }
  saveCodeVerifier(v: string) {
    this.write({ verifier: v });
  }
  codeVerifier() {
    const v = this.read().verifier;
    if (!v) throw new Error("No code verifier saved");
    return v;
  }
}

interface NoteHit {
  id: string;
  title: string;
  modified: string | null;
}

/**
 * Wispr Flow notes, through Wispr's official remote MCP server, with Ava as
 * an MCP client. Sign-in is OAuth in the browser; no desktop session reuse.
 * Off by default.
 */
export class WisprSource implements SourcePlugin {
  readonly id = "wispr";
  readonly label = "Wispr Flow notes";
  readonly description = "Reads your Wispr Flow scratchpad notes through Wispr's official MCP server and proposes what's in them.";
  readonly defaultOn = false;
  readonly pollEveryMinutes = 120;
  private auth: WisprOAuth;

  constructor(private svc: Services) {
    this.auth = new WisprOAuth(svc);
  }

  configured(): boolean {
    return !!this.svc.cfg.wisprMcpUrl;
  }
  needs(): string | null {
    return this.connected() ? null : "Connect your Wispr Flow account";
  }
  connected(): boolean {
    return !!this.auth.tokens();
  }

  private transport() {
    return new StreamableHTTPClientTransport(new URL(this.svc.cfg.wisprMcpUrl), { authProvider: this.auth });
  }

  /** Start connecting. Returns a URL to open if sign-in is needed. */
  async connect(): Promise<{ connected: boolean; authUrl: string | null }> {
    const client = new Client({ name: "ava", version: "0.1.0" });
    const t = this.transport();
    try {
      await client.connect(t);
      await client.close();
      return { connected: true, authUrl: null };
    } catch (e) {
      if (e instanceof UnauthorizedError || this.auth.pendingAuthUrl) return { connected: false, authUrl: this.auth.pendingAuthUrl };
      throw e;
    }
  }

  async finishAuth(code: string): Promise<void> {
    const t = this.transport();
    await t.finishAuth(code);
    this.svc.log.info("source.wispr", "Wispr Flow connected");
  }

  private async withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: "ava", version: "0.1.0" });
    await client.connect(this.transport());
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => {});
    }
  }

  private static textOf(res: unknown): string {
    const content = (res as { content?: { type: string; text?: string }[] }).content ?? [];
    return content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }

  private static parseHits(text: string): { hits: NoteHit[]; next: string | null } {
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      const list = (data.notes ?? data.results ?? data.items ?? []) as Record<string, unknown>[];
      return {
        hits: list.map((n) => ({ id: String(n.id ?? n.note_id), title: String(n.title ?? ""), modified: (n.modified_at ?? n.updated_at ?? n.modified ?? null) as string | null })).filter((h) => h.id && h.id !== "undefined"),
        next: data.has_more ? String(data.next_cursor ?? "") || null : null,
      };
    } catch {
      return { hits: [], next: null };
    }
  }

  async poll(wakeId: string | null): Promise<string> {
    if (!this.connected()) return "not connected";
    const { evidence, proposals, log, clock, models } = this.svc;
    const st = readSource(this.svc, this.id);
    const since = String(st.state.since ?? new Date(clock.now().getTime() - 14 * 86_400_000).toISOString());
    const notes = await this.withClient(async (c) => {
      const out: { id: string; title: string; text: string; modified: string | null }[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const args: Record<string, unknown> = { since, limit: 50 };
        if (cursor) args.cursor = cursor;
        const res = await c.callTool({ name: "search_scratchpad_notes", arguments: args });
        const { hits, next } = WisprSource.parseHits(WisprSource.textOf(res));
        for (const h of hits) {
          const full = await c.callTool({ name: "get_scratchpad_note", arguments: { note_id: h.id } });
          out.push({ ...h, text: WisprSource.textOf(full) });
        }
        if (!next) break;
        cursor = next;
      }
      return out;
    });
    let made = 0;
    for (const n of notes) {
      if (n.text.trim().length < 30) continue;
      const entryId = this.svc.memory.append({ kind: "transcript", source: this.id, text: n.text, occurred_at: n.modified ?? clock.now().toISOString(), meta: { title: n.title } });
      const evId = evidence.add({ kind: "note", source: this.id, source_ref: `${n.id}:${n.modified ?? ""}`, occurred_at: n.modified ?? clock.now().toISOString(), summary: n.title, content: { entry_id: entryId } });
      if (!models.available) continue;
      try {
        const changes = await extract(this.svc, n.text.slice(0, 12_000), { purpose: "wispr.extract", origin: "system", extraInstruction: "This is a note Shreyas dictated in Wispr Flow." });
        if (changes.length) made += proposals.createBatch(this.id, changes.map((c) => ({ ...c, evidence_id: evId }))).proposals.length;
        evidence.markDistilled(evId);
      } catch (e) {
        log.warn("source.wispr", `Couldn't read note "${n.title}": ${(e as Error).message}`, undefined, wakeId);
      }
    }
    writeSourceState(this.svc, this.id, { ...st.state, since: clock.now().toISOString() }, { ok: true });
    return `${notes.length} notes read, ${made} proposals`;
  }

  stats(): Record<string, number> {
    const e = this.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM evidence WHERE source = ?", [this.id])?.n ?? 0;
    return { notes: e, to_review: this.svc.proposals.pendingCountByOrigin()[this.id] ?? 0 };
  }

  deleteData(): number {
    this.svc.db.run("DELETE FROM proposals WHERE origin = ? AND status = 'pending'", [this.id]);
    writeSecrets(this.svc, "wispr", null);
    writeSourceState(this.svc, this.id, {});
    this.svc.memory.forgetBySource(this.id, "you deleted the Wispr source data");
    return this.svc.evidence.deleteBySource(this.id);
  }
}
