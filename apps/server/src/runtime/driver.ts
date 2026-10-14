import type { RuntimePreset } from "@agentown/core";
import type { Duplex, Readable, Writable } from "node:stream";

/** Everything the controller needs to materialize one agent runtime generation. */
export interface RuntimeSpec {
  agentId: string;
  generation: number;
  namespace: string;
  preset: RuntimePreset;
  apiUrl: string;
  storageRef: string;
  displayName: string;
  jobRole: string;
  /** Plaintext provider key for this agent only (null = none). Delivered as a per-agent secret. */
  providerKey: string | null;
  /** Sent as the anthropic-workspace-id header when the key is not scoped to a workspace. */
  providerWorkspaceId: string | null;
}

export interface PodInfo {
  name: string;
  generation: number;
  phase: string; // Pending | Running | Succeeded | Failed | Unknown
  ready: boolean;
  terminating: boolean;
  restarts: number;
  waitingReason: string | null;
  message: string | null;
}

export interface ExecStreams {
  stdin: Readable;
  /** Must carry `columns`/`rows` and emit "resize" for TTY sizing. */
  stdout: Writable;
  onExit: (status: { status?: string; message?: string }) => void;
}

/**
 * Runtime driver. The controller is the only caller; agents never get a driver
 * handle, a kubeconfig or a Docker socket.
 */
export interface RuntimeDriver {
  readonly kind: string;
  listPods(namespace: string, agentId: string): Promise<PodInfo[]>;
  /** Idempotently create the per-agent ServiceAccount, workspace volume and credential Secret. */
  ensureIdentity(spec: RuntimeSpec, issueToken: () => Promise<string>): Promise<void>;
  createPod(spec: RuntimeSpec): Promise<string>;
  deletePod(namespace: string, name: string): Promise<void>;
  /** Remove credential + identity; workspace only when purgeWorkspace. */
  teardown(namespace: string, agentId: string, purgeWorkspace: boolean): Promise<void>;
  exec(namespace: string, pod: string, command: string[], streams: ExecStreams): Promise<{ close: () => void }>;
}

export function podName(agentId: string, generation: number): string {
  return `agent-${agentId}-g${generation}`;
}

export type { Duplex };
