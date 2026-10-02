import { localDateKey, type Location } from "@ava/shared";
import type { Db } from "../db/db";
import { j, js } from "../db/db";
import type { Clock } from "./clock";
import { SettingsSchema, type Settings } from "../config/settings";

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return (patch ?? base) as T;
  if (!base || typeof base !== "object" || Array.isArray(base)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export class SettingsStore {
  private cache: Settings | null = null;
  private listeners: ((s: Settings, prev: Settings) => void)[] = [];

  constructor(
    private db: Db,
    private defaults: Settings,
  ) {}

  get(): Settings {
    if (this.cache) return this.cache;
    const row = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'settings'");
    const merged = deepMerge(this.defaults, j(row?.value, {}));
    const parsed = SettingsSchema.safeParse(merged);
    this.cache = parsed.success ? parsed.data : this.defaults;
    return this.cache;
  }

  /** Apply a partial update. Throws with readable messages if the result is invalid. */
  update(patch: Partial<Settings> | Record<string, unknown>, now: Date): Settings {
    const prev = this.get();
    const next = deepMerge(prev, patch);
    const parsed = SettingsSchema.safeParse(next);
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    this.db.run(
      "INSERT INTO settings (key, value, updated_at) VALUES ('settings', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [js(parsed.data), now.toISOString()],
    );
    this.cache = parsed.data;
    for (const l of this.listeners) l(parsed.data, prev);
    return parsed.data;
  }

  onChange(fn: (s: Settings, prev: Settings) => void): void {
    this.listeners.push(fn);
  }

  location(): Location {
    const s = this.get();
    return s.locations.find((l) => l.id === s.current_location_id) ?? s.locations[0];
  }

  tz(): string {
    return this.location().tz;
  }
}

/** Per-local-day counters: messages sent, model calls, spend, wakes by kind. */
export class Counters {
  constructor(
    private db: Db,
    private clock: Clock,
    private tz: () => string,
  ) {}

  today(): string {
    return localDateKey(this.clock.now(), this.tz());
  }

  get(key: string, date = this.today()): number {
    return this.db.get<{ value: number }>("SELECT value FROM daily_counters WHERE date = ? AND key = ?", [date, key])?.value ?? 0;
  }

  add(key: string, by = 1, date = this.today()): number {
    this.db.run(
      "INSERT INTO daily_counters (date, key, value) VALUES (?, ?, ?) ON CONFLICT(date, key) DO UPDATE SET value = value + excluded.value",
      [date, key, by],
    );
    return this.get(key, date);
  }

  all(date = this.today()): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.all<{ key: string; value: number }>("SELECT key, value FROM daily_counters WHERE date = ?", [date])) out[r.key] = r.value;
    return out;
  }
}
