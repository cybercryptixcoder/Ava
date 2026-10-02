import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { MIGRATIONS } from "./schema";

export type Row = Record<string, unknown>;
export type Params = Record<string, SQLInputValue | undefined> | SQLInputValue[];

/** Thin, synchronous wrapper around node:sqlite with migrations. */
export class Db {
  readonly raw: DatabaseSync;
  private stmtCache = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  constructor(readonly file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const row = this.raw.prepare("SELECT MAX(version) AS v FROM _migrations").get() as { v: number | null };
    const current = row?.v ?? 0;
    for (let i = current; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[i]);
        this.raw.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)").run(i + 1, new Date().toISOString());
      });
    }
  }

  private prep(sql: string) {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  private clean(params?: Params): SQLInputValue[] | Record<string, SQLInputValue> {
    if (!params) return [];
    if (Array.isArray(params)) return params.map((v) => (v === undefined ? null : v));
    const out: Record<string, SQLInputValue> = {};
    for (const [k, v] of Object.entries(params)) out[k] = v === undefined ? null : v;
    return out;
  }

  all<T = Row>(sql: string, params?: Params): T[] {
    const p = this.clean(params);
    const s = this.prep(sql);
    return (Array.isArray(p) ? s.all(...p) : s.all(p)) as T[];
  }

  get<T = Row>(sql: string, params?: Params): T | undefined {
    const p = this.clean(params);
    const s = this.prep(sql);
    return (Array.isArray(p) ? s.get(...p) : s.get(p)) as T | undefined;
  }

  run(sql: string, params?: Params): { changes: number; lastInsertRowid: number | bigint } {
    const p = this.clean(params);
    const s = this.prep(sql);
    const r = Array.isArray(p) ? s.run(...p) : s.run(p);
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  private depth = 0;
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.raw.exec("BEGIN");
    this.depth++;
    try {
      const r = fn();
      this.raw.exec("COMMIT");
      return r;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.raw.close();
  }
}

/** Prefixed, sortable-enough random id: tsk_k3j9x2m1q8. */
export function newId(prefix: string): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = randomBytes(10);
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `${prefix}_${s}`;
}

export function j<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined || v === "") return fallback;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
}

export function js(v: unknown): string {
  return JSON.stringify(v ?? null);
}
