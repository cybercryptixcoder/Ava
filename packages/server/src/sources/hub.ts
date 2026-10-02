import type { SourceView } from "@ava/shared";
import type { Services } from "../core/services";
import { ActivitySource } from "./activity";
import { ChatImportSource } from "./chat-import";
import { GoogleCalendarSource } from "./gcal";
import { GmailSentSource } from "./gmail";
import { GoogleAuth } from "./google";
import { IcsSource } from "./ics";
import { SavedItemsSource } from "./saved";
import { readSource, writeSourceState } from "./state";
import type { SourcePlugin } from "./types";
import { WisprSource } from "./wispr";

/** Voice/conversation and manual entry are sources too; they never poll. */
class SimpleSource implements SourcePlugin {
  constructor(
    private svc: Services,
    readonly id: string,
    readonly label: string,
    readonly description: string,
    private count: () => number,
  ) {}
  readonly defaultOn = true;
  configured() {
    return true;
  }
  needs() {
    return null;
  }
  connected() {
    return true;
  }
  stats() {
    return { entries: this.count() };
  }
  deleteData(): number {
    if (this.id === "voice") return this.svc.evidence.deleteBySource("voice");
    return this.svc.db.run("DELETE FROM items WHERE source = 'manual'").changes;
  }
}

export class SourceHub {
  readonly google: GoogleAuth;
  readonly gcal: GoogleCalendarSource;
  readonly ics: IcsSource;
  readonly chatImport: ChatImportSource;
  readonly gmail: GmailSentSource;
  readonly activity: ActivitySource;
  readonly saved: SavedItemsSource;
  readonly wispr: WisprSource;
  readonly all: SourcePlugin[];

  constructor(private svc: Services) {
    this.google = new GoogleAuth(svc);
    this.gcal = new GoogleCalendarSource(svc, this.google);
    this.ics = new IcsSource(svc);
    this.chatImport = new ChatImportSource(svc);
    this.gmail = new GmailSentSource(svc, this.google);
    this.activity = new ActivitySource(svc);
    this.saved = new SavedItemsSource(svc);
    this.wispr = new WisprSource(svc);
    this.all = [
      new SimpleSource(svc, "voice", "Voice and conversation", "What you say or type to Ava: the main stream.", () => svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM turns WHERE role = 'user'")?.n ?? 0),
      this.gcal,
      this.ics,
      new SimpleSource(svc, "manual", "Manual entry", "Tasks and projects you add by hand.", () => svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE source = 'manual' AND deleted_at IS NULL")?.n ?? 0),
      this.chatImport,
      this.gmail,
      this.activity,
      this.saved,
      this.wispr,
    ];
  }

  get(id: string): SourcePlugin | undefined {
    return this.all.find((s) => s.id === id);
  }

  enabled(id: string): boolean {
    return this.svc.settings.get().sources[id] ?? this.get(id)?.defaultOn ?? false;
  }

  views(): SourceView[] {
    return this.all.map((s) => {
      const st = readSource(this.svc, s.id);
      const icsErr = s.id === "ics" ? (this.ics.feeds().find((f) => f.last_error)?.last_error ?? null) : null;
      return {
        id: s.id,
        label: s.label,
        description: s.description,
        enabled: this.enabled(s.id),
        default_on: s.defaultOn,
        configured: s.configured(),
        needs: s.needs(),
        connected: s.connected(),
        last_sync_at: st.last_sync_at,
        last_error: st.last_error ?? icsErr,
        stats: s.stats(),
      };
    });
  }

  /** Step 1 of a heartbeat: poll each enabled source that can't push, if it's due. */
  async pollDue(wakeId: string | null, force = false): Promise<void> {
    const { clock, log } = this.svc;
    for (const s of this.all) {
      if (!s.poll || !this.enabled(s.id) || !s.connected()) continue;
      const st = readSource(this.svc, s.id);
      const due = force || !st.last_sync_at || clock.now().getTime() - new Date(st.last_sync_at).getTime() >= (s.pollEveryMinutes ?? 60) * 60_000;
      if (!due) continue;
      try {
        const summary = await s.poll(wakeId);
        writeSourceState(this.svc, s.id, readSource(this.svc, s.id).state, { ok: true });
        log.info("source.poll", `${s.label}: ${summary}`, undefined, wakeId);
      } catch (e) {
        writeSourceState(this.svc, s.id, st.state, { ok: false, error: (e as Error).message });
        log.warn("source.poll_failed", `${s.label} failed: ${(e as Error).message}`, undefined, wakeId);
      }
    }
  }

  async syncNow(id: string): Promise<string> {
    const s = this.get(id);
    if (!s?.poll) return "This source has nothing to sync";
    const summary = await s.poll(null);
    writeSourceState(this.svc, s.id, readSource(this.svc, s.id).state, { ok: true });
    this.svc.bus.emit({ type: "state.changed", what: ["items", "sources"] });
    return summary;
  }

  deleteData(id: string): number {
    const s = this.get(id);
    if (!s) throw new Error(`Unknown source ${id}`);
    const n = s.deleteData();
    this.svc.log.info("source.deleted", `Deleted ${n} records from ${s.label}`, { source: id });
    this.svc.bus.emit({ type: "state.changed", what: ["items", "sources", "beliefs"] });
    return n;
  }

  gmailCanSend(): boolean {
    return this.gmail.canSend();
  }

  gmailSend(p: { to: string; subject: string; body: string }): Promise<string> {
    return this.gmail.send(p);
  }
}
