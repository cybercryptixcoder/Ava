import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "./api";

/**
 * A tiny data layer. Each path is fetched once and shared; any
 * "state.changed" event from the server's event stream refreshes every
 * mounted query (debounced). Simple, and enough for one person's data.
 */
type Entry = { data: unknown; error: string | null; loading: boolean; at: number; listeners: Set<() => void>; inflight: Promise<void> | null };
const cache = new Map<string, Entry>();

function entry(path: string): Entry {
  let e = cache.get(path);
  if (!e) {
    e = { data: undefined, error: null, loading: false, at: 0, listeners: new Set(), inflight: null };
    cache.set(path, e);
  }
  return e;
}

function notify(e: Entry) {
  for (const l of e.listeners) l();
}

export function refetch(path: string): Promise<void> {
  const e = entry(path);
  if (e.inflight) return e.inflight;
  e.loading = true;
  notify(e);
  e.inflight = api
    .get(path)
    .then((d) => {
      e.data = d;
      e.error = null;
    })
    .catch((err: Error) => {
      e.error = err.message;
    })
    .finally(() => {
      e.loading = false;
      e.at = Date.now();
      e.inflight = null;
      notify(e);
    });
  return e.inflight;
}

export function refetchAll(): void {
  for (const [path, e] of cache) if (e.listeners.size) void refetch(path);
}

export function setData<T>(path: string, updater: (prev: T | undefined) => T): void {
  const e = entry(path);
  e.data = updater(e.data as T | undefined);
  notify(e);
}

export function useApi<T>(path: string | null): { data: T | undefined; error: string | null; loading: boolean; reload: () => Promise<void> } {
  const key = path ?? "__none__";
  const subscribe = useCallback(
    (cb: () => void) => {
      const e = entry(key);
      e.listeners.add(cb);
      return () => e.listeners.delete(cb);
    },
    [key],
  );
  const snap = useSyncExternalStore(
    subscribe,
    () => {
      const e = entry(key);
      return `${e.at}:${e.loading}:${e.error ?? ""}`;
    },
    () => "",
  );
  void snap;
  useEffect(() => {
    if (!path) return;
    const e = entry(path);
    if (!e.at && !e.inflight) void refetch(path);
  }, [path]);
  const e = entry(key);
  return { data: e.data as T | undefined, error: e.error, loading: e.loading, reload: () => (path ? refetch(path) : Promise.resolve()) };
}

/** Subscribe to the server's event stream once for the whole app. */
let source: EventSource | null = null;
const eventListeners = new Set<(e: { type: string; [k: string]: unknown }) => void>();
let debounce: number | null = null;

export function startEvents(): void {
  if (source) return;
  source = new EventSource("/api/events", { withCredentials: true });
  source.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data) as { type: string; [k: string]: unknown };
      for (const l of eventListeners) l(e);
      if (["state.changed", "wake.finished", "message.sent", "exec.updated", "brief.ready", "clock.changed"].includes(e.type)) {
        if (debounce) window.clearTimeout(debounce);
        debounce = window.setTimeout(refetchAll, 250);
      }
    } catch {
      /* ignore */
    }
  };
  source.onerror = () => {
    // The browser reconnects on its own.
  };
}

export function useServerEvents(fn: (e: { type: string; [k: string]: unknown }) => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const l = (e: { type: string; [k: string]: unknown }) => ref.current(e);
    eventListeners.add(l);
    return () => {
      eventListeners.delete(l);
    };
  }, []);
}

/** Run an action, then refresh everything. Returns [run, busy, error]. */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>): [(...a: A) => Promise<R | undefined>, boolean, string | null] {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (...a: A) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn(...a);
      refetchAll();
      return r;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return [run, busy, error];
}
