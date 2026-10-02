import { EventEmitter } from "node:events";

/**
 * In-process event bus. The app subscribes over Server-Sent Events so every
 * open screen updates when state changes (a wake ran, a message went out,
 * an executor finished, the canvas changed).
 */
export type AvaEvent =
  | { type: "state.changed"; what: string[] }
  | { type: "wake.finished"; wake_id: string; kind: string; outcome: string }
  | { type: "message.sent"; message_id: string }
  | { type: "canvas.changed"; conversation_id: string }
  | { type: "exec.updated"; exec_task_id: string; status: string }
  | { type: "brief.ready"; brief_id: string }
  | { type: "clock.changed"; now: string }
  | { type: "log"; id: number; kind: string; summary: string };

export class EventBus {
  private ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(100);
  }
  emit(e: AvaEvent): void {
    this.ee.emit("event", e);
  }
  on(fn: (e: AvaEvent) => void): () => void {
    this.ee.on("event", fn);
    return () => this.ee.off("event", fn);
  }
}
