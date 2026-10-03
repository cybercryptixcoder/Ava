import { z } from "zod";
import type { Services } from "../core/services";
import { newId } from "../db/db";

const CoreSchema = z.object({ core: z.string() });

/**
 * L3: the core. A small, stable block of what Ava durably knows — who he is,
 * standing preferences, active threads and their current state. Regenerated
 * from L2 (facts), threads and recent episode gists during consolidation;
 * versioned, never edited in place. The conversation reads the latest version
 * (it is the cache breakpoint of the system prompt); the conversation model
 * never writes it.
 */
export class Core {
  private cached: { version: number; text: string } | null = null;

  constructor(private svc: Services) {}

  /** The latest stored version, or null when none exists yet. */
  latest(): { version: number; text: string; created_at: string } | null {
    const r = this.svc.db.get<{ version: number; text_enc: string; created_at: string }>("SELECT version, text_enc, created_at FROM cores ORDER BY version DESC LIMIT 1");
    if (!r) return null;
    return { version: r.version, text: this.svc.cipher.decOpt(r.text_enc) ?? "", created_at: String(r.created_at) };
  }

  /** What the conversation puts in its prompt: the latest core, built on first need when a model is available. */
  async ensure(): Promise<string | null> {
    if (this.cached) return this.cached.text;
    const last = this.latest();
    if (last) {
      this.cached = last;
      return last.text;
    }
    return await this.rebuild();
  }

  versions(limit = 20): { version: number; tokens: number; created_at: string }[] {
    return this.svc.db.all("SELECT version, tokens, created_at FROM cores ORDER BY version DESC LIMIT ?", [limit]);
  }

  /** Write the next version from current facts, threads and recent gists. Null when there is nothing (or no model) yet. */
  async rebuild(): Promise<string | null> {
    const { models, cfg, db, cipher, settings, log } = this.svc;
    if (!models.available) return null;
    const s = settings.get().memory;
    const facts = db
      .all<{ statement_enc: string }>("SELECT statement_enc FROM facts WHERE status = 'current' AND valid_to IS NULL ORDER BY importance DESC, recorded_at DESC LIMIT 40")
      .map((r) => `- ${cipher.decOpt(r.statement_enc) ?? ""}`);
    const threads = this.svc.threads.activeTopLevel().map((t) => `- ${t.title} (${t.id}): ${this.svc.items.list({ thread_id: t.id, open: true }).map((i) => i.title).join("; ") || "nothing open"}`);
    const gists = db
      .all<{ gist_enc: string | null; start_at: string }>("SELECT gist_enc, start_at FROM episodes WHERE gist_enc IS NOT NULL ORDER BY start_at DESC LIMIT 10")
      .map((r) => `- ${r.start_at.slice(0, 10)}: ${cipher.decOpt(r.gist_enc as string) ?? ""}`);
    const parts = [facts.length ? `Facts:\n${facts.join("\n")}` : "", threads.length ? `Active threads:\n${threads.join("\n")}` : "", gists.length ? `Recent days:\n${gists.join("\n")}` : ""].filter(Boolean);
    if (!parts.length) return null; // nothing to say yet; don't invent
    try {
      const r = await models.complete({
        purpose: "memory.core",
        origin: "system",
        model: cfg.models.fast,
        maxTokens: s.core_budget_tokens,
        system:
          `You write the core memory of a personal assistant for ${cfg.ownerName}. Merge the input into a short, stable reference: who they are, standing preferences, active threads and their current state. Terse bullet points; no flattery, no speculation; only what the input states. Return JSON {"core": "<text>"}.`,
        messages: [{ role: "user", content: parts.join("\n\n") }],
        schema: CoreSchema,
      });
      const text = r.parsed?.core?.trim();
      if (!text) return null;
      const version = db.get<{ v: number }>("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM cores")?.v ?? 1;
      const now = this.svc.clock.now().toISOString();
      const tokens = Math.ceil(text.length / 4);
      db.run("INSERT INTO cores (id, version, text_enc, tokens, created_at) VALUES (?, ?, ?, ?, ?)", [newId("cor"), version, cipher.encrypt(text), tokens, now]);
      this.cached = { version, text };
      log.info("memory.core", `Core v${version} written (${tokens} tokens)`);
      return text;
    } catch (e) {
      log.warn("memory.core", `Core rebuild failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** Drop the in-process cache (a new version was written elsewhere). */
  invalidate(): void {
    this.cached = null;
  }
}
