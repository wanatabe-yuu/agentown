export const TASK_STATUSES = [
  "queued", // created, no assignee yet
  "assigned",
  "in_progress",
  "review",
  "done",
  "blocked",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["assigned", "cancelled"],
  assigned: ["in_progress", "assigned", "cancelled", "blocked"],
  in_progress: ["review", "done", "failed", "blocked", "assigned", "cancelled"],
  review: ["done", "assigned", "cancelled"],
  blocked: ["assigned", "in_progress", "cancelled"],
  failed: ["assigned", "cancelled"],
  done: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: TaskStatus): boolean {
  return status === "done" || status === "cancelled";
}

/**
 * Task spec understood by the built-in harness adapters.
 *
 * - playbook: runs an owner-approved script baked into the runtime image; args
 *   arrive as environment variables, never spliced into shell text.
 * - script: inline shell. Equivalent to a shell in the assignee's runtime, so the
 *   server requires runtime.exec on the assignee (or assignee == creator).
 * - prompt: free-form work for an LLM harness from description + acceptance criteria.
 */
export type TaskSpec =
  | { kind: "playbook"; playbook: string; args?: Record<string, string> }
  | { kind: "script"; script: string }
  | { kind: "prompt" };

export const PLAYBOOK_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const PLAYBOOK_ARG_NAME = /^[A-Z][A-Z0-9_]{0,40}$/;
