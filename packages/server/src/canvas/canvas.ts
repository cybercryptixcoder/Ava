import { mergeSpec, moduleSummaryLine, type CanvasState, type HydratedModule, type TurnView } from "@ava/shared";
import type { Services } from "../core/services";
import { j, js, newId } from "../db/db";
import { Hydrator } from "./hydrate";

interface ModuleRow {
  id: string;
  conversation_id: string;
  key: string;
  type: string;
  spec: string;
  status: "visible" | "dismissed";
  version: number;
  position: number;
  created_at: string;
  updated_at: string;
}

/**
 * The canvas: the composed surface Ava draws on while she talks. Modules are
 * stored as specs and re-hydrated from live state every time they're read,
 * so a task checked off elsewhere shows as done here too.
 */
export class Canvas {
  readonly hydrator: Hydrator;
  /** Hours of silence after which a new conversation (and a fresh canvas) begins. */
  static readonly IDLE_HOURS = 8;

  constructor(private svc: Services) {
    this.hydrator = new Hydrator(svc);
  }

  /** The current conversation, starting a new one after a long idle gap. */
  current(forceNew = false): string {
    const { db, clock } = this.svc;
    const last = db.get<{ id: string; last: string | null; started_at: string }>(
      "SELECT c.id, c.started_at, (SELECT MAX(created_at) FROM turns t WHERE t.conversation_id = c.id) AS last FROM conversations c ORDER BY c.started_at DESC LIMIT 1",
    );
    const now = clock.now();
    const idle = last ? now.getTime() - new Date(last.last ?? last.started_at).getTime() > Canvas.IDLE_HOURS * 3_600_000 : true;
    if (last && !idle && !forceNew) return last.id;
    if (last && !last.last && !forceNew) return last.id;
    const id = newId("cnv");
    db.run("INSERT INTO conversations (id, started_at) VALUES (?, ?)", [id, now.toISOString()]);
    return id;
  }

  private rows(convId: string, includeDismissed = false): ModuleRow[] {
    return this.svc.db.all<ModuleRow>(
      `SELECT * FROM canvas_modules WHERE conversation_id = ? ${includeDismissed ? "" : "AND status = 'visible'"} ORDER BY position`,
      [convId],
    );
  }

  /** Validate, hydrate and place a module. Failures aren't rendered and are logged. */
  show(convId: string, spec: unknown, via: string): { ok: true; module: HydratedModule } | { ok: false; errors: string[] } {
    const { db, clock, log } = this.svc;
    const res = this.hydrator.hydrate(spec);
    if (!res.ok) {
      log.warn("canvas.invalid", `A ${String((spec as { type?: string })?.type ?? "module")} block failed validation and was not rendered: ${res.errors.join("; ")}`, { spec, via });
      return res;
    }
    const now = clock.now().toISOString();
    const existing = db.get<ModuleRow>("SELECT * FROM canvas_modules WHERE conversation_id = ? AND key = ?", [convId, res.module.key]);
    if (existing) {
      db.run("UPDATE canvas_modules SET type = ?, spec = ?, status = 'visible', version = version + 1, updated_at = ? WHERE id = ?", [res.module.type, js(res.module.spec), now, existing.id]);
    } else {
      const pos = db.get<{ p: number | null }>("SELECT MAX(position) AS p FROM canvas_modules WHERE conversation_id = ?", [convId])?.p ?? 0;
      db.run("INSERT INTO canvas_modules (id, conversation_id, key, type, spec, status, version, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'visible', 1, ?, ?, ?)", [
        newId("mod"),
        convId,
        res.module.key,
        res.module.type,
        js(res.module.spec),
        pos + 1,
        now,
        now,
      ]);
    }
    this.svc.bus.emit({ type: "canvas.changed", conversation_id: convId });
    return { ok: true, module: this.get(convId, res.module.key)! };
  }

  /** Modify a module in place ("let me move that to tomorrow" visibly moves it). */
  update(convId: string, key: string, patch: Record<string, unknown>, via: string): { ok: true; module: HydratedModule } | { ok: false; errors: string[] } {
    const row = this.svc.db.get<ModuleRow>("SELECT * FROM canvas_modules WHERE conversation_id = ? AND key = ?", [convId, key]);
    if (!row) {
      this.svc.log.warn("canvas.invalid", `Update for unknown module "${key}" ignored`, { patch, via });
      return { ok: false, errors: [`No module ${key} on the canvas`] };
    }
    const merged = mergeSpec(j(row.spec, {}), { ...patch, key, type: row.type });
    return this.show(convId, merged, via);
  }

  remove(convId: string, key: string): void {
    this.svc.db.run("UPDATE canvas_modules SET status = 'dismissed', updated_at = ? WHERE conversation_id = ? AND key = ?", [this.svc.clock.now().toISOString(), convId, key]);
    this.svc.bus.emit({ type: "canvas.changed", conversation_id: convId });
  }

  clear(convId: string): void {
    this.svc.db.run("UPDATE canvas_modules SET status = 'dismissed' WHERE conversation_id = ?", [convId]);
    this.svc.bus.emit({ type: "canvas.changed", conversation_id: convId });
  }

  get(convId: string, key: string): HydratedModule | null {
    const row = this.svc.db.get<ModuleRow>("SELECT * FROM canvas_modules WHERE conversation_id = ? AND key = ?", [convId, key]);
    return row ? this.hydrateRow(row) : null;
  }

  private hydrateRow(row: ModuleRow): HydratedModule | null {
    const res = this.hydrator.hydrate(j(row.spec, {}), { created_at: row.created_at, updated_at: row.updated_at, version: row.version, status: row.status });
    if (!res.ok) return null;
    const m = res.module;
    if (m.data.type === "options") {
      const chosen = this.svc.db.get<{ detail: string }>("SELECT detail FROM canvas_events WHERE conversation_id = ? AND module_key = ? AND kind = 'choose_option' ORDER BY id DESC LIMIT 1", [
        row.conversation_id,
        row.key,
      ]);
      if (chosen) m.data.chosen = j<{ option: string }>(chosen.detail, { option: "" }).option;
    }
    return m;
  }

  modules(convId: string): HydratedModule[] {
    return this.rows(convId)
      .map((r) => this.hydrateRow(r))
      .filter((m): m is HydratedModule => !!m);
  }

  state(convId: string, turnLimit = 40): CanvasState {
    return { conversation_id: convId, modules: this.modules(convId), turns: this.svc.conversation.turns(convId, turnLimit) };
  }

  /** Compact summary of what's on screen, included in Ava's context every turn. */
  summary(convId: string): string {
    const mods = this.modules(convId);
    if (!mods.length) return "The canvas is empty.";
    return mods.map((m) => `- ${moduleSummaryLine(m)}`).join("\n");
  }

  /** Record something Shreyas did on the canvas; Ava sees it on her next turn. */
  event(convId: string, kind: string, moduleKey: string | null, detail: unknown): void {
    this.svc.db.run("INSERT INTO canvas_events (conversation_id, module_key, kind, detail, at) VALUES (?, ?, ?, ?, ?)", [
      convId,
      moduleKey,
      kind,
      js(detail),
      this.svc.clock.now().toISOString(),
    ]);
    this.svc.bus.emit({ type: "canvas.changed", conversation_id: convId });
  }

  /** Interactions since Ava's last turn, consumed once. */
  takeEvents(convId: string): string[] {
    const { db } = this.svc;
    const rows = db.all<{ id: number; kind: string; module_key: string | null; detail: string }>("SELECT * FROM canvas_events WHERE conversation_id = ? AND consumed = 0 ORDER BY id", [convId]);
    if (rows.length) db.run(`UPDATE canvas_events SET consumed = 1 WHERE id IN (${rows.map(() => "?").join(",")})`, rows.map((r) => r.id));
    return rows.map((r) => {
      const d = j<Record<string, unknown>>(r.detail, {});
      return `${r.kind.replace(/_/g, " ")}${r.module_key ? ` on ${r.module_key}` : ""}: ${Object.entries(d)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(", ")}`;
    });
  }

  /** Turns for display, newest last. */
  turnsFor(convId: string): TurnView[] {
    return this.svc.conversation.turns(convId);
  }
}
