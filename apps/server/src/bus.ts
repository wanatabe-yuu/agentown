import { EventEmitter } from "node:events";

export interface AgentEventRow {
  /** The organization the event belongs to: subscribers filter on it before anything else. */
  orgId: string;
  seq: number;
  at: string;
  agentId: string | null;
  taskId: string | null;
  runId: string | null;
  type: string;
  payload: Record<string, unknown>;
}

/** In-process fan-out of committed events to SSE subscribers (single server process in the MVP). */
export class EventBus {
  private readonly emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(0);
  }
  publish(events: AgentEventRow[]): void {
    for (const e of events) this.emitter.emit("event", e);
  }
  subscribe(fn: (e: AgentEventRow) => void): () => void {
    this.emitter.on("event", fn);
    return () => this.emitter.off("event", fn);
  }
}
