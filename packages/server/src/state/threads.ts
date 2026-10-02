import { type HydratedItem, type Item, type ItemDraft, type ThreadNode } from "@ava/shared";
import type { Db } from "../db/db";
import { newId } from "../db/db";
import type { Clock } from "../core/clock";
import type { DecisionLog } from "../core/log";
import type { SettingsStore } from "../core/settings-store";
import type { ItemStore } from "./items";

/** Item types that live in threads. Events, goals, preferences and saved items don't. */
const THREADED = new Set(["task", "commitment", "open_loop", "project"]);
const COURSE = /^[A-Z]{2,5}\s?\d{2,4}[A-Z]?\b/;
const GROUP_COURSES = "Coursework";
const GROUP_SMALL = "Smaller things";
const PEOPLE = "People to get back to";
const LOOSE = "Loose ends";

export interface Thread {
  id: string;
  title: string;
  status: "active" | "merged";
  parent_id: string | null;
  merged_into: string | null;
  created_by: "ava" | "user";
  created_at: string;
  updated_at: string;
}

/** Everything needed to put threads back the way they were (undo). */
export interface ThreadSnapshot {
  threads: Thread[];
  items: { id: string; thread_id: string | null }[];
}

function rowToThread(r: Record<string, unknown>): Thread {
  return {
    id: String(r.id),
    title: String(r.title),
    status: r.status as Thread["status"],
    parent_id: (r.parent_id as string) ?? null,
    merged_into: (r.merged_into as string) ?? null,
    created_by: r.created_by as Thread["created_by"],
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

/**
 * Threads: a small number of top-level areas of his life right now ("Midterm
 * week", "Finish the SOP"). Ava files every task, deadline, commitment and
 * open loop under one, from the extraction and planning paths or, when there
 * is no hint, by what the item is attached to. The top level stays short: past
 * the limit, Ava groups threads further instead of showing more.
 */
export class ThreadStore {
  constructor(
    private db: Db,
    private clock: Clock,
    private items: ItemStore,
    private settings: SettingsStore,
    private log: DecisionLog,
  ) {}

  get(id: string): Thread | null {
    const r = this.db.get("SELECT * FROM threads WHERE id = ?", [id]);
    return r ? rowToThread(r) : null;
  }

  list(): Thread[] {
    return this.db.all("SELECT * FROM threads WHERE status = 'active' ORDER BY created_at").map(rowToThread);
  }

  byTitle(title: string): Thread | null {
    const t = title.trim().toLowerCase();
    if (!t) return null;
    const all = this.list();
    return (
      all.find((x) => x.title.toLowerCase() === t) ??
      // Loose match for spoken titles ("the SOP" for "Finish the SOP"), only for distinctive words.
      (t.length >= 4 ? (all.find((x) => x.title.toLowerCase().includes(t) || (t.includes(x.title.toLowerCase()) && x.title.length >= 4)) ?? null) : null)
    );
  }

  create(title: string, by: "ava" | "user"): Thread {
    const now = this.clock.now().toISOString();
    const id = newId("thr");
    this.db.run("INSERT INTO threads (id, title, status, created_by, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)", [id, title.trim(), by, now, now]);
    this.log.info("threads.created", `New thread: ${title.trim()}`, { thread_id: id, by });
    return this.get(id)!;
  }

  threadable(item: { type: string }): boolean {
    return THREADED.has(item.type);
  }

  /** Pick the thread for an item (or a draft about to be created), creating one if needed. */
  resolve(item: Pick<ItemDraft, "type" | "title" | "project_id" | "parent_id" | "data">, hint?: string | null): string {
    const data = (item.data ?? {}) as Record<string, unknown>;
    if (hint) {
      const t = this.byTitle(hint);
      if (t) return t.id;
    }
    if (item.parent_id) {
      const parent = this.items.get(item.parent_id);
      if (parent) return parent.thread_id ?? this.place(parent) ?? this.findOrCreate(LOOSE);
    }
    if (item.project_id) {
      const project = this.items.get(item.project_id);
      if (project) return project.thread_id ?? this.place(project) ?? this.findOrCreate(LOOSE);
    }
    // A thread Ava named on purpose beats the fallbacks below.
    if (hint) return this.findOrCreate(hint);
    if (item.type === "project") return this.findOrCreate(item.title);
    if (typeof data.course === "string" && data.course.trim()) return this.findOrCreate(data.course.trim());
    if ((item.type === "commitment" || item.type === "open_loop") && (data.to_person || data.counterpart)) return this.findOrCreate(PEOPLE);
    return this.findOrCreate(LOOSE);
  }

  private findOrCreate(title: string): string {
    return (this.byTitle(title) ?? this.create(title, "ava")).id;
  }

  /** File an item under a thread if it has none (or under the hinted one). Returns the thread id. */
  place(item: Item, hint?: string | null): string | null {
    if (!this.threadable(item)) return null;
    if (item.thread_id && !hint && this.get(item.thread_id)?.status === "active") return item.thread_id;
    const id = this.resolve(item, hint);
    this.assign([item.id], id);
    return id;
  }

  /** Move items between threads without touching anything else about them. */
  assign(itemIds: string[], threadId: string | null): void {
    for (const id of itemIds) this.db.run("UPDATE items SET thread_id = ? WHERE id = ?", [threadId, id]);
    // Subtasks follow their parent.
    for (const id of itemIds) this.db.run("UPDATE items SET thread_id = ? WHERE parent_id = ? AND deleted_at IS NULL", [threadId, id]);
  }

  rename(id: string, title: string, via: string): Thread {
    const t = this.get(id);
    if (!t) throw new Error(`No thread ${id}`);
    this.db.run("UPDATE threads SET title = ?, updated_at = ? WHERE id = ?", [title.trim(), this.clock.now().toISOString(), id]);
    this.log.info("threads.renamed", `Renamed thread "${t.title}" to "${title.trim()}"`, { thread_id: id, via });
    return this.get(id)!;
  }

  merge(ids: string[], intoId: string, via: string): Thread {
    const into = this.get(intoId);
    if (!into) throw new Error(`No thread ${intoId}`);
    const now = this.clock.now().toISOString();
    const merged: string[] = [];
    for (const id of ids.filter((x) => x !== intoId)) {
      const t = this.get(id);
      if (!t || t.status !== "active") continue;
      this.db.run("UPDATE items SET thread_id = ? WHERE thread_id = ?", [intoId, id]);
      this.db.run("UPDATE threads SET parent_id = ? WHERE parent_id = ?", [intoId, id]);
      this.db.run("UPDATE threads SET status = 'merged', merged_into = ?, updated_at = ? WHERE id = ?", [intoId, now, id]);
      merged.push(t.title);
    }
    this.log.info("threads.merged", `Merged ${merged.map((m) => `"${m}"`).join(", ")} into "${into.title}"`, { into: intoId, via });
    return this.get(intoId)!;
  }

  /** Move items to a thread, or to a new thread by title (a split). */
  move(itemIds: string[], target: { thread_id?: string; title?: string }, via: string): Thread {
    const thread = target.thread_id ? this.get(target.thread_id) : target.title ? (this.byTitle(target.title) ?? this.create(target.title, via.startsWith("user") ? "user" : "ava")) : null;
    if (!thread) throw new Error("Say which thread to move them to");
    this.assign(itemIds, thread.id);
    this.log.info("threads.moved", `Moved ${itemIds.length} item${itemIds.length === 1 ? "" : "s"} to "${thread.title}"`, { thread_id: thread.id, items: itemIds, via });
    this.enforceCap();
    return thread;
  }

  snapshot(threadIds: string[]): ThreadSnapshot {
    const ids = Array.from(new Set(threadIds));
    const threads = ids.map((id) => this.get(id)).filter((t): t is Thread => !!t);
    const children = ids.length ? this.db.all(`SELECT * FROM threads WHERE parent_id IN (${ids.map(() => "?").join(",")})`, ids).map(rowToThread) : [];
    const items = ids.length
      ? this.db.all<{ id: string; thread_id: string | null }>(`SELECT id, thread_id FROM items WHERE thread_id IN (${ids.map(() => "?").join(",")})`, ids)
      : [];
    return { threads: [...threads, ...children], items };
  }

  /** Group a thread under a broader one (created if needed), keeping the top level short. */
  nest(threadId: string, groupTitle: string): void {
    const g = this.byTitle(groupTitle) ?? this.create(groupTitle, "ava");
    if (g.id === threadId) return;
    this.db.run("UPDATE threads SET parent_id = ?, updated_at = ? WHERE id = ?", [g.id, this.clock.now().toISOString(), threadId]);
  }

  /** Put threads and item placement back as they were in a snapshot. */
  restore(s: ThreadSnapshot, itemSnapshot: { id: string; thread_id: string | null }[] = []): void {
    for (const t of s.threads) {
      this.db.run("UPDATE threads SET title = ?, status = ?, parent_id = ?, merged_into = ?, updated_at = ? WHERE id = ?", [t.title, t.status, t.parent_id, t.merged_into, this.clock.now().toISOString(), t.id]);
    }
    for (const it of [...s.items, ...itemSnapshot]) this.db.run("UPDATE items SET thread_id = ? WHERE id = ?", [it.thread_id, it.id]);
  }

  /** Drop a thread Ava created that no longer holds anything (after an undo). */
  removeIfEmpty(id: string): void {
    const n = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE thread_id = ? AND deleted_at IS NULL", [id])?.n ?? 0;
    const kids = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM threads WHERE parent_id = ? AND status = 'active'", [id])?.n ?? 0;
    if (!n && !kids) this.db.run("DELETE FROM threads WHERE id = ?", [id]);
  }

  private openItems(threadId: string): Item[] {
    return this.items.list({ thread_id: threadId, open: true }).filter((i) => this.threadable(i));
  }

  private openCount(threadId: string, seen = new Set<string>()): number {
    if (seen.has(threadId)) return 0;
    seen.add(threadId);
    const own = this.openItems(threadId).length;
    const kids = this.db.all<{ id: string }>("SELECT id FROM threads WHERE parent_id = ? AND status = 'active'", [threadId]);
    return own + kids.reduce((n, k) => n + this.openCount(k.id, seen), 0);
  }

  /** Top-level threads that hold something open, most open first. */
  activeTopLevel(): (Thread & { open: number })[] {
    return this.list()
      .filter((t) => !t.parent_id)
      .map((t) => ({ ...t, open: this.openCount(t.id) }))
      .filter((t) => t.open > 0)
      .sort((a, b) => b.open - a.open);
  }

  /** Keep the top level at or under the limit by grouping further, never by hiding. */
  enforceCap(): void {
    const max = this.settings.get().threads.max_active;
    let top = this.activeTopLevel();
    if (top.length <= max) return;
    const grouped: string[] = [];
    const nest = (child: Thread, groupTitle: string) => {
      this.nest(child.id, groupTitle);
      grouped.push(`"${child.title}" under "${groupTitle}"`);
    };
    const courses = top.filter((t) => COURSE.test(t.title));
    if (courses.length >= 2) for (const c of courses) nest(c, GROUP_COURSES);
    top = this.activeTopLevel();
    for (let guard = 0; top.length > max && guard < 50; guard++) {
      const smallest = [...top].filter((t) => t.title !== GROUP_SMALL && t.title !== GROUP_COURSES).sort((a, b) => a.open - b.open)[0];
      if (!smallest) break;
      nest(smallest, GROUP_SMALL);
      top = this.activeTopLevel();
    }
    if (grouped.length) this.log.info("threads.grouped", `More than ${max} threads, so Ava grouped ${grouped.join(", ")}`, { grouped });
  }

  /** File every open item that has no thread yet (startup, imports, the test profile). */
  backfill(): number {
    const open = this.items.list({ open: true }).filter((i) => this.threadable(i) && !i.thread_id);
    // Projects first so their tasks follow them, parents before subtasks.
    open.sort((a, b) => Number(b.type === "project") - Number(a.type === "project") || Number(!!a.parent_id) - Number(!!b.parent_id));
    let n = 0;
    for (const it of open) {
      const fresh = this.items.get(it.id);
      if (fresh && !fresh.thread_id && this.place(fresh)) n++;
    }
    this.enforceCap();
    return n;
  }

  /** The full hierarchy for the Everything view: threads, then items, then subtasks. */
  tree(now: Date, tz: string): ThreadNode[] {
    const build = (t: Thread, seen: Set<string>): ThreadNode => {
      seen.add(t.id);
      // A project that gave the thread its name is the thread; don't list it inside itself.
      const own = this.openItems(t.id).filter((i) => !(i.type === "project" && i.title.toLowerCase() === t.title.toLowerCase()));
      const byParent = new Map<string, HydratedItem[]>();
      const subs = this.items.list({ thread_id: t.id, open: true }).filter((i) => i.parent_id);
      for (const s of subs) byParent.set(s.parent_id!, [...(byParent.get(s.parent_id!) ?? []), this.items.hydrate(s, now, tz)]);
      const items = own
        .filter((i) => !i.parent_id)
        .sort(byUrgency)
        .map((i) => ({ ...this.items.hydrate(i, now, tz), subtasks: byParent.get(i.id) ?? [] }));
      const children = this.db
        .all("SELECT * FROM threads WHERE parent_id = ? AND status = 'active' ORDER BY created_at", [t.id])
        .map(rowToThread)
        .filter((c) => !seen.has(c.id))
        .map((c) => build(c, seen))
        .filter((c) => c.open_count > 0);
      return { id: t.id, title: t.title, open_count: own.length + children.reduce((n, c) => n + c.open_count, 0), children, items };
    };
    const seen = new Set<string>();
    return this.activeTopLevel().map((t) => build(t, seen));
  }
}

function byUrgency(a: Item, b: Item): number {
  const da = a.due_at ? Date.parse(a.due_at) : Infinity;
  const db = b.due_at ? Date.parse(b.due_at) : Infinity;
  return da - db || a.title.localeCompare(b.title);
}
