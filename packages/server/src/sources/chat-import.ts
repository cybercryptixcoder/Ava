import { DateTime } from "luxon";
import type { Services } from "../core/services";
import { newId } from "../db/db";
import { extract } from "../conversation/extraction";
import { parseChatExport, userTextOf } from "./parsers/chat-export";
import { readSource, writeSourceState } from "./state";
import type { SourcePlugin } from "./types";

interface ImportJob {
  id: string;
  filename: string;
  platform: string;
  conversations: number;
  kept: number;
  processed: number;
  proposals: number;
  status: "running" | "done" | "paused";
  started_at: string;
  warnings: string[];
}

const BATCH_CHARS = 18_000;
const CALLS_PER_RUN = 25;

/**
 * One-time import of ChatGPT and Claude exports. Staged: deterministic
 * parsing and trimming to his own words, then batched extraction weighted by
 * date (old goals may be dead), into a review queue he works through.
 */
export class ChatImportSource implements SourcePlugin {
  readonly id = "chat_import";
  readonly label = "Chatbot history import";
  readonly description = "Import your ChatGPT and Claude exports once. Ava proposes projects, goals, interests and commitments for you to review.";
  readonly defaultOn = true;
  readonly pollEveryMinutes = 30;
  private running = false;

  constructor(private svc: Services) {}

  configured(): boolean {
    return true;
  }
  needs(): string | null {
    return null;
  }
  connected(): boolean {
    return this.jobs().length > 0;
  }

  jobs(): ImportJob[] {
    return (readSource(this.svc, this.id).state.jobs as ImportJob[]) ?? [];
  }

  private saveJobs(jobs: ImportJob[]) {
    const st = readSource(this.svc, this.id);
    writeSourceState(this.svc, this.id, { ...st.state, jobs });
  }

  /** Stage 1: parse, trim to his words, store the words in the raw log. */
  ingest(file: Buffer, filename: string): ImportJob {
    const { evidence, memory, clock, log } = this.svc;
    const { conversations, warnings } = parseChatExport(file, filename);
    let kept = 0;
    for (const c of conversations) {
      const text = userTextOf(c);
      if (text.length < 60) continue;
      // His words go into the raw log permanently; the evidence row keeps only
      // what review and extraction need, pointing back at the entry.
      const entryId = memory.append({
        kind: "import",
        source: this.id,
        session_id: `${c.platform}:${c.id}`,
        occurred_at: c.updated_at,
        text,
        meta: { title: c.title, platform: c.platform, created_at: c.created_at, updated_at: c.updated_at },
      });
      evidence.add({
        kind: "conversation_import",
        source: this.id,
        source_ref: `${c.platform}:${c.id}`,
        occurred_at: c.updated_at,
        summary: c.title,
        content: { entry_id: entryId, title: c.title, platform: c.platform, updated_at: c.updated_at },
      });
      kept++;
    }
    const job: ImportJob = {
      id: newId("imp"),
      filename,
      platform: conversations[0]?.platform ?? "unknown",
      conversations: conversations.length,
      kept,
      processed: 0,
      proposals: 0,
      status: "running",
      started_at: clock.now().toISOString(),
      warnings,
    };
    this.saveJobs([...this.jobs(), job]);
    log.info("source.chat_import", `Imported ${filename}: ${conversations.length} conversations, ${kept} with enough of your own words to review`, { job: job.id, warnings });
    void this.process(null);
    return job;
  }

  /** Stage 2: batched extraction, weighted by recency. Resumable across runs. */
  async process(wakeId: string | null): Promise<string> {
    if (this.running) return "already running";
    this.running = true;
    const { db, evidence, memory, proposals, clock, log, settings } = this.svc;
    try {
      const pending = db.all<{ id: string }>("SELECT id FROM evidence WHERE source = ? AND distilled_at IS NULL ORDER BY occurred_at DESC", [this.id]);
      if (!pending.length) return "nothing to process";
      let calls = 0,
        made = 0,
        done = 0;
      let i = 0;
      while (i < pending.length && calls < CALLS_PER_RUN) {
        const batch: { id: string; title: string; date: string; text: string }[] = [];
        let size = 0;
        while (i < pending.length && size < BATCH_CHARS) {
          const e = evidence.get(pending[i].id);
          i++;
          if (!e) continue;
          const c = e.content as { title: string; updated_at: string; entry_id?: string };
          const text = c.entry_id ? (memory.get(c.entry_id)?.text ?? "") : "";
          if (!text) {
            // Nothing to read (forgotten, or a pre-upgrade row with no copy): don't wedge the queue.
            evidence.markDistilled(e.id);
            continue;
          }
          batch.push({ id: e.id, title: c.title, date: c.updated_at.slice(0, 10), text });
          size += text.length;
        }
        if (!batch.length) break;
        const text = batch.map((b) => `### ${b.title} (last active ${b.date})\n${b.text}`).join("\n\n");
        calls++;
        try {
          const changes = await extract(this.svc, text, {
            purpose: "import.extract",
            origin: "interactive",
            extraInstruction:
              "This is Shreyas's side of old chatbot conversations, not something he just said. Propose only durable things: projects he was building, goals, real interests, commitments to people, preferences. Skip one-off questions and homework help. For anything older than a few months, create projects with status 'paused' and goals as-is; he'll decide what still matters. Put the conversation's date in the summary, like 'Project (Mar 2025): ...'. Never create tasks from old conversations.",
          });
          const now = clock.now().getTime();
          const entries = changes
            .filter((c) => c.change.op === "create_item" || c.change.op === "add_belief")
            .map((c) => {
              const dateMatch = /\((\w{3} \d{4})\)/.exec(c.summary);
              const when = dateMatch ? DateTime.fromFormat(dateMatch[1], "LLL yyyy").toJSDate().getTime() : now - 180 * 86_400_000;
              const ageDays = Math.max(0, (now - when) / 86_400_000);
              return { ...c, weight: Math.round(Math.pow(0.5, ageDays / 120) * 1000) / 1000, evidence_id: batch[0].id };
            });
          if (entries.length) made += proposals.createBatch(this.id, entries).proposals.length;
          for (const b of batch) evidence.markDistilled(b.id);
          done += batch.length;
        } catch (e) {
          log.warn("source.chat_import", `Import batch failed, will retry on the next run: ${(e as Error).message}`, undefined, wakeId);
          break;
        }
      }
      const remaining = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM evidence WHERE source = ? AND distilled_at IS NULL", [this.id])?.n ?? 0;
      const jobs = this.jobs().map((j) => (j.status === "running" ? { ...j, processed: j.processed + done, proposals: j.proposals + made, status: remaining ? ("running" as const) : ("done" as const) } : j));
      this.saveJobs(jobs);
      writeSourceState(this.svc, this.id, readSource(this.svc, this.id).state, { ok: true });
      log.info("source.chat_import", `Processed ${done} conversations into ${made} proposals; ${remaining} left`, undefined, wakeId);
      void settings;
      return `${done} processed, ${made} proposals, ${remaining} left`;
    } finally {
      this.running = false;
    }
  }

  async poll(wakeId: string | null): Promise<string> {
    const anyPending = this.svc.db.get("SELECT id FROM evidence WHERE source = ? AND distilled_at IS NULL LIMIT 1", [this.id]);
    if (!anyPending || !this.svc.models.available) return "idle";
    return this.process(wakeId);
  }

  stats(): Record<string, number> {
    const p = this.svc.proposals.pendingCountByOrigin()[this.id] ?? 0;
    const e = this.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM evidence WHERE source = ?", [this.id])?.n ?? 0;
    return { conversations: e, to_review: p };
  }

  deleteData(): number {
    this.svc.db.run("DELETE FROM proposals WHERE origin = ? AND status = 'pending'", [this.id]);
    this.saveJobs([]);
    this.svc.memory.forgetBySource(this.id, "you deleted the imported chat data");
    return this.svc.evidence.deleteBySource(this.id);
  }
}
