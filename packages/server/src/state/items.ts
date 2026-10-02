import {
  ITEM_TYPES,
  isClosed,
  statusLabel,
  relativePhrase,
  type HydratedItem,
  type Item,
  type ItemDraft,
  type ItemPatch,
  type ItemType,
} from "@ava/shared";
import type { Db } from "../db/db";
import { j, js, newId } from "../db/db";
import type { Clock } from "../core/clock";

export type ItemChangeKind = "created" | "updated" | "status" | "completed" | "deleted";
export interface ItemChange {
  kind: ItemChangeKind;
  item: Item;
  before: Item | null;
  via: string;
}

function rowToItem(r: Record<string, unknown>): Item {
  return {
    id: String(r.id),
    type: r.type as ItemType,
    title: String(r.title),
    status: String(r.status),
    data: j(r.data, {}),
    due_at: (r.due_at as string) ?? null,
    start_at: (r.start_at as string) ?? null,
    end_at: (r.end_at as string) ?? null,
    project_id: (r.project_id as string) ?? null,
    importance: r.importance === null || r.importance === undefined ? null : Number(r.importance),
    tags: j(r.tags, []),
    source: String(r.source),
    source_ref: (r.source_ref as string) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    touched_at: String(r.touched_at),
    status_changed_at: String(r.status_changed_at),
    completed_at: (r.completed_at as string) ?? null,
  };
}

export interface ItemFilter {
  types?: ItemType[];
  statuses?: string[];
  open?: boolean;
  project_id?: string;
  tag?: string;
  due_before?: string;
  due_after?: string;
  starts_between?: [string, string];
  q?: string;
  ids?: string[];
  source?: string;
  limit?: number;
}

/** Normalize a date-ish string to ISO UTC, or null. */
export function normalizeInstant(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export class ItemStore {
  private hooks: ((c: ItemChange) => void)[] = [];

  constructor(
    private db: Db,
    private clock: Clock,
  ) {}

  onChange(fn: (c: ItemChange) => void): void {
    this.hooks.push(fn);
  }

  private emit(c: ItemChange) {
    for (const h of this.hooks) {
      try {
        h(c);
      } catch (e) {
        console.error("item hook failed", e);
      }
    }
  }

  get(id: string): Item | null {
    const r = this.db.get("SELECT * FROM items WHERE id = ? AND deleted_at IS NULL", [id]);
    return r ? rowToItem(r) : null;
  }

  getBySourceRef(source: string, ref: string): Item | null {
    const r = this.db.get("SELECT * FROM items WHERE source = ? AND source_ref = ?", [source, ref]);
    return r ? rowToItem(r) : null;
  }

  byIds(ids: string[]): Item[] {
    if (!ids.length) return [];
    const rows = this.db.all(`SELECT * FROM items WHERE deleted_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`, ids);
    const map = new Map(rows.map((r) => [String(r.id), rowToItem(r)]));
    return ids.map((id) => map.get(id)).filter((x): x is Item => !!x);
  }

  list(f: ItemFilter = {}): Item[] {
    const where: string[] = ["deleted_at IS NULL"];
    const p: (string | number)[] = [];
    if (f.types?.length) {
      where.push(`type IN (${f.types.map(() => "?").join(",")})`);
      p.push(...f.types);
    }
    if (f.statuses?.length) {
      where.push(`status IN (${f.statuses.map(() => "?").join(",")})`);
      p.push(...f.statuses);
    }
    if (f.project_id) {
      where.push("project_id = ?");
      p.push(f.project_id);
    }
    if (f.tag) {
      where.push("tags LIKE ?");
      p.push(`%"${f.tag}"%`);
    }
    if (f.due_before) {
      where.push("due_at IS NOT NULL AND due_at < ?");
      p.push(f.due_before);
    }
    if (f.due_after) {
      where.push("due_at IS NOT NULL AND due_at >= ?");
      p.push(f.due_after);
    }
    if (f.starts_between) {
      where.push("start_at IS NOT NULL AND start_at < ? AND COALESCE(end_at, start_at) >= ?");
      p.push(f.starts_between[1], f.starts_between[0]);
    }
    if (f.q) {
      where.push("title LIKE ?");
      p.push(`%${f.q}%`);
    }
    if (f.ids?.length) {
      where.push(`id IN (${f.ids.map(() => "?").join(",")})`);
      p.push(...f.ids);
    }
    if (f.source) {
      where.push("source = ?");
      p.push(f.source);
    }
    let items = this.db
      .all(`SELECT * FROM items WHERE ${where.join(" AND ")} ORDER BY COALESCE(due_at, start_at, '9999') ASC, created_at ASC LIMIT ?`, [...p, f.limit ?? 2000])
      .map(rowToItem);
    if (f.open) items = items.filter((i) => !isClosed(i.type, i.status));
    return items;
  }

  private validate(type: ItemType, status: string | undefined, data: Record<string, unknown> | undefined) {
    const def = ITEM_TYPES[type];
    if (!def) throw new Error(`Unknown item type ${type}`);
    if (status && !def.statuses.includes(status)) throw new Error(`"${status}" is not a valid status for a ${def.label.toLowerCase()} (use ${def.statuses.join(", ")})`);
    if (data) {
      const r = def.data.safeParse(data);
      if (!r.success) throw new Error(`Invalid ${type} fields: ${r.error.issues.map((i) => i.message).join("; ")}`);
    }
  }

  create(draft: ItemDraft, opts: { source: string; source_ref?: string | null; via?: string }): Item {
    this.validate(draft.type, draft.status, draft.data);
    const now = this.clock.now().toISOString();
    const def = ITEM_TYPES[draft.type];
    const id = newId(def.idPrefix);
    const status = draft.status ?? def.statuses[0];
    this.db.run(
      `INSERT INTO items (id, type, title, status, data, due_at, start_at, end_at, project_id, importance, tags, source, source_ref,
        created_at, updated_at, touched_at, status_changed_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        draft.type,
        draft.title.trim(),
        status,
        js(draft.data ?? {}),
        normalizeInstant(draft.due_at),
        normalizeInstant(draft.start_at),
        normalizeInstant(draft.end_at),
        draft.project_id ?? null,
        draft.importance ?? null,
        js(draft.tags ?? []),
        opts.source,
        opts.source_ref ?? null,
        now,
        now,
        now,
        now,
        isClosed(draft.type, status) ? now : null,
      ],
    );
    const item = this.get(id)!;
    this.history(id, "created", null, item.title, opts.via ?? opts.source);
    this.emit({ kind: "created", item, before: null, via: opts.via ?? opts.source });
    return item;
  }

  update(id: string, patch: ItemPatch, via: string, opts: { touch?: boolean } = {}): Item {
    const before = this.get(id);
    if (!before) throw new Error(`No item ${id}`);
    const nextStatus = patch.status ?? before.status;
    const nextData = patch.data ? { ...before.data, ...patch.data } : before.data;
    this.validate(before.type, nextStatus, nextData);
    const now = this.clock.now().toISOString();
    const statusChanged = nextStatus !== before.status;
    const closedNow = isClosed(before.type, nextStatus);
    const fields: Record<string, unknown> = {
      title: patch.title?.trim() ?? before.title,
      status: nextStatus,
      data: js(nextData),
      due_at: patch.due_at !== undefined ? normalizeInstant(patch.due_at) : before.due_at,
      start_at: patch.start_at !== undefined ? normalizeInstant(patch.start_at) : before.start_at,
      end_at: patch.end_at !== undefined ? normalizeInstant(patch.end_at) : before.end_at,
      project_id: patch.project_id !== undefined ? patch.project_id : before.project_id,
      importance: patch.importance !== undefined ? patch.importance : before.importance,
      tags: js(patch.tags ?? before.tags),
      updated_at: now,
      touched_at: opts.touch === false ? before.touched_at : now,
      status_changed_at: statusChanged ? now : before.status_changed_at,
      completed_at: closedNow ? (before.completed_at ?? now) : null,
    };
    this.db.run(
      `UPDATE items SET title=?, status=?, data=?, due_at=?, start_at=?, end_at=?, project_id=?, importance=?, tags=?,
        updated_at=?, touched_at=?, status_changed_at=?, completed_at=? WHERE id=?`,
      [
        fields.title as string,
        fields.status as string,
        fields.data as string,
        fields.due_at as string | null,
        fields.start_at as string | null,
        fields.end_at as string | null,
        fields.project_id as string | null,
        fields.importance as number | null,
        fields.tags as string,
        now,
        fields.touched_at as string,
        fields.status_changed_at as string,
        fields.completed_at as string | null,
        id,
      ],
    );
    const item = this.get(id)!;
    for (const k of ["title", "status", "due_at", "start_at", "end_at", "project_id", "importance"] as const) {
      if (JSON.stringify(before[k]) !== JSON.stringify(item[k])) this.history(id, k, before[k], item[k], via);
    }
    if (item.project_id && opts.touch !== false) {
      this.db.run("UPDATE items SET touched_at = ? WHERE id = ?", [now, item.project_id]);
    }
    const kind: ItemChangeKind = statusChanged ? (closedNow ? "completed" : "status") : "updated";
    this.emit({ kind, item, before, via });
    return item;
  }

  setStatus(id: string, status: string, via: string): Item {
    return this.update(id, { status }, via);
  }

  complete(id: string, via: string): Item {
    const item = this.get(id);
    if (!item) throw new Error(`No item ${id}`);
    const def = ITEM_TYPES[item.type];
    const doneStatus = def.closed[0] ?? item.status;
    return this.update(id, { status: doneStatus }, via);
  }

  touch(id: string, at?: Date): void {
    this.db.run("UPDATE items SET touched_at = ? WHERE id = ?", [(at ?? this.clock.now()).toISOString(), id]);
  }

  remove(id: string, via: string): void {
    const before = this.get(id);
    if (!before) return;
    this.db.run("UPDATE items SET deleted_at = ? WHERE id = ?", [this.clock.now().toISOString(), id]);
    this.history(id, "deleted", null, null, via);
    this.emit({ kind: "deleted", item: before, before, via });
  }

  /** Create or update an item mirrored from an external source (calendar, feeds). */
  upsertExternal(source: string, sourceRef: string, draft: ItemDraft): { item: Item; created: boolean; changed: boolean } {
    const existing = this.db.get("SELECT * FROM items WHERE source = ? AND source_ref = ?", [source, sourceRef]);
    if (!existing) return { item: this.create(draft, { source, source_ref: sourceRef, via: source }), created: true, changed: true };
    const before = rowToItem(existing);
    if (existing.deleted_at) this.db.run("UPDATE items SET deleted_at = NULL WHERE id = ?", [before.id]);
    const same =
      before.title === draft.title &&
      before.start_at === normalizeInstant(draft.start_at) &&
      before.end_at === normalizeInstant(draft.end_at) &&
      before.due_at === normalizeInstant(draft.due_at) &&
      (draft.status === undefined || draft.status === before.status) &&
      JSON.stringify(before.data) === JSON.stringify({ ...before.data, ...(draft.data ?? {}) });
    if (same) return { item: before, created: false, changed: false };
    const item = this.update(
      before.id,
      { title: draft.title, start_at: draft.start_at, end_at: draft.end_at, due_at: draft.due_at, status: draft.status, data: draft.data, tags: draft.tags },
      source,
      { touch: false },
    );
    return { item, created: false, changed: true };
  }

  private history(itemId: string, field: string, oldV: unknown, newV: unknown, via: string) {
    this.db.run("INSERT INTO item_history (item_id, at, field, old_value, new_value, via) VALUES (?, ?, ?, ?, ?, ?)", [
      itemId,
      this.clock.now().toISOString(),
      field,
      oldV === null || oldV === undefined ? null : String(oldV),
      newV === null || newV === undefined ? null : String(newV),
      via,
    ]);
  }

  historyFor(itemId: string, limit = 50): { at: string; field: string; old_value: string | null; new_value: string | null; via: string }[] {
    return this.db.all("SELECT at, field, old_value, new_value, via FROM item_history WHERE item_id = ? ORDER BY id DESC LIMIT ?", [itemId, limit]);
  }

  /** Completions per local day, used by charts. */
  completionsBetween(from: string, to: string): { at: string; item_id: string }[] {
    return this.db.all(
      "SELECT at, item_id FROM item_history WHERE field = 'status' AND new_value IN ('done','closed','achieved') AND at >= ? AND at < ? ORDER BY at",
      [from, to],
    );
  }

  hydrate(item: Item, now: Date, tz: string, projectTitles?: Map<string, string>): HydratedItem {
    const projectTitle = item.project_id ? (projectTitles?.get(item.project_id) ?? this.get(item.project_id)?.title ?? null) : null;
    return {
      id: item.id,
      type: item.type,
      title: item.title,
      status: item.status,
      status_label: statusLabel(item.status),
      due_at: item.due_at,
      due_phrase: item.due_at ? relativePhrase(now, item.due_at, tz) : null,
      start_at: item.start_at,
      project_id: item.project_id,
      project_title: projectTitle,
      importance: item.importance,
      tags: item.tags,
      kind: (item.data.kind as string) ?? null,
      estimate_minutes: (item.data.estimate_minutes as number) ?? null,
      touched_at: item.touched_at,
      days_in_status: Math.max(0, (now.getTime() - new Date(item.status_changed_at).getTime()) / 86_400_000),
    };
  }
}

export { rowToItem };
