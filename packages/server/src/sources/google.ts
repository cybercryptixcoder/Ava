import { randomBytes } from "node:crypto";
import type { Services } from "../core/services";
import { readSource, readSecrets, writeSecrets, writeSourceState } from "./state";

/**
 * Google OAuth 2.0 for Calendar and Gmail, done with plain HTTPS calls
 * against Google's documented endpoints. Tokens are stored encrypted.
 * Incremental authorization: connecting Gmail later adds its scopes to the
 * same grant.
 */
export const SCOPES = {
  calendar: ["https://www.googleapis.com/auth/calendar.readonly"],
  gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
  gmailSend: ["https://www.googleapis.com/auth/gmail.send"],
};

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope: string;
}

export class GoogleAuth {
  private pendingStates = new Map<string, { scopes: string[]; at: number }>();

  constructor(private svc: Services) {}

  get redirectUri(): string {
    return `${this.svc.cfg.publicUrl}/api/oauth/google/callback`;
  }

  configured(): boolean {
    return !!(this.svc.cfg.google.clientId && this.svc.cfg.google.clientSecret);
  }

  tokens(): Tokens | null {
    return readSecrets<Tokens>(this.svc, "google");
  }

  hasScope(scope: string): boolean {
    return (this.tokens()?.scope ?? "").split(" ").includes(scope);
  }

  authUrl(kind: "calendar" | "gmail"): string {
    if (!this.configured()) throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first");
    const scopes = kind === "calendar" ? SCOPES.calendar : [...SCOPES.gmail, ...(this.svc.cfg.google.gmailSend ? SCOPES.gmailSend : [])];
    const state = randomBytes(16).toString("hex");
    this.pendingStates.set(state, { scopes, at: Date.now() });
    const p = new URLSearchParams({
      client_id: this.svc.cfg.google.clientId!,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: ["openid", "email", ...scopes].join(" "),
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
  }

  async handleCallback(code: string, state: string): Promise<void> {
    const pending = this.pendingStates.get(state);
    if (!pending || Date.now() - pending.at > 15 * 60_000) throw new Error("This sign-in link expired. Start the connection again from Settings.");
    this.pendingStates.delete(state);
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.svc.cfg.google.clientId!,
        client_secret: this.svc.cfg.google.clientSecret!,
        redirect_uri: this.redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) throw new Error(`Google sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
    const prev = this.tokens();
    writeSecrets(this.svc, "google", {
      access_token: body.access_token,
      refresh_token: body.refresh_token ?? prev?.refresh_token,
      expires_at: Date.now() + (body.expires_in ?? 3600) * 1000,
      scope: body.scope ?? "",
    });
    this.svc.log.info("source.google", `Google connected with scopes: ${body.scope}`);
  }

  async accessToken(): Promise<string> {
    const t = this.tokens();
    if (!t) throw new Error("Google isn't connected");
    if (t.expires_at - 60_000 > Date.now()) return t.access_token;
    if (!t.refresh_token) throw new Error("Google needs to be reconnected (no refresh token)");
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.svc.cfg.google.clientId!,
        client_secret: this.svc.cfg.google.clientSecret!,
        refresh_token: t.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number; scope?: string; error?: string };
    if (!res.ok || !body.access_token) throw new Error(`Google token refresh failed: ${body.error ?? res.status}`);
    writeSecrets(this.svc, "google", { ...t, access_token: body.access_token, expires_at: Date.now() + (body.expires_in ?? 3600) * 1000, scope: body.scope ?? t.scope });
    return body.access_token;
  }

  async api<T>(url: string, init: RequestInit = {}): Promise<T> {
    const token = await this.accessToken();
    const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`Google API ${res.status}: ${text.slice(0, 300)}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  disconnect(): void {
    const t = this.tokens();
    if (t) void fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refresh_token ?? t.access_token)}`, { method: "POST" }).catch(() => {});
    writeSecrets(this.svc, "google", null);
    const s = readSource(this.svc, "gcal");
    writeSourceState(this.svc, "gcal", { ...s.state, syncTokens: {}, channel: null });
  }
}
