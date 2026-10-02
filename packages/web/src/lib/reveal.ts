import { useSyncExternalStore } from "react";

/**
 * Speech-synced reveal. When Ava speaks, any module or module part named by
 * a cue stays hidden until the word after the cue is spoken. Without audio,
 * everything shows at once in order.
 */
const pending = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
const timers: number[] = [];

function bump() {
  version++;
  for (const l of listeners) l();
}

export function holdTargets(targets: string[]): void {
  for (const t of targets) pending.add(t);
  bump();
}

export function revealTarget(t: string): void {
  if (pending.delete(t)) bump();
}

export function revealAll(): void {
  for (const id of timers.splice(0)) window.clearTimeout(id);
  if (pending.size) {
    pending.clear();
    bump();
  }
}

/** Schedule reveals relative to an audio start time (performance.now() ms). */
export function scheduleReveals(cues: { target: string; at_ms: number }[], startedAt: number): void {
  for (const c of cues) {
    const delay = Math.max(0, startedAt + c.at_ms - performance.now());
    timers.push(window.setTimeout(() => revealTarget(c.target), delay));
  }
}

export function isHidden(key: string, segment?: string): boolean {
  if (pending.has(key)) return true;
  if (segment !== undefined && pending.has(`${key}.${segment}`)) return true;
  return false;
}

export function useRevealVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
}

/** Play a rendered reply or brief, revealing cued parts on time. */
let current: HTMLAudioElement | null = null;
export function playSpeech(audioId: string, cues: { target: string; at_ms: number }[], hooks: { onStart?: () => void; onEnd?: () => void; onProgress?: (p: number) => void } = {}): HTMLAudioElement {
  stopSpeech();
  holdTargets(cues.map((c) => c.target));
  const audio = new Audio(`/api/audio/${audioId}`);
  current = audio;
  let started = false;
  audio.addEventListener("playing", () => {
    if (started) return;
    started = true;
    scheduleReveals(cues, performance.now() - audio.currentTime * 1000);
    hooks.onStart?.();
  });
  audio.addEventListener("timeupdate", () => {
    if (audio.duration) hooks.onProgress?.(audio.currentTime / audio.duration);
  });
  const end = () => {
    revealAll();
    if (current === audio) current = null;
    hooks.onEnd?.();
  };
  audio.addEventListener("ended", end);
  audio.addEventListener("error", end);
  audio.play().catch(() => end());
  return audio;
}

export function stopSpeech(): void {
  if (current) {
    current.pause();
    current = null;
  }
  revealAll();
}
