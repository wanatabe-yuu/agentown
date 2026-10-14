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
  /** This agent's own LLM credential (null = none). The key is delivered as a per-agent secret. */
  llm: RuntimeLlm | null;
}

/** The LLM credential an agent's runtime holds. */
export interface RuntimeLlm {
  provider: string;
  /** Plaintext key; "" for a custom endpoint that needs none. */
  apiKey: string;
  /** Anthropic only: sent as the anthropic-workspace-id header when the key is not scoped to a workspace. */
  workspaceId: string | null;
  /** OpenAI-compatible providers: the Chat Completions endpoint. */
  baseUrl: string | null;
}

/** Harness environment for a credential: `secret` goes into the per-agent Secret, `plain` is set as is. */
export function llmEnv(llm: RuntimeLlm): { secret: Record<string, string>; plain: Record<string, string> } {
  if (llm.provider === "anthropic") {
    return {
      secret: { ANTHROPIC_API_KEY: llm.apiKey },
      plain: { AGENTOWN_LLM_PROVIDER: "anthropic", ...(llm.workspaceId ? { ANTHROPIC_WORKSPACE_ID: llm.workspaceId } : {}) },
    };
  }
  return {
    secret: llm.apiKey ? { AGENTOWN_LLM_API_KEY: llm.apiKey } : {},
    plain: { AGENTOWN_LLM_PROVIDER: llm.provider, AGENTOWN_LLM_BASE_URL: llm.baseUrl ?? "" },
  };
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

/** The runtime's namespace does not exist (or grants us nothing) yet: the cluster provisioner has not run. */
export class NamespaceNotReady extends Error {
  constructor(readonly namespace: string) {
    super(`namespace ${namespace} is not provisioned yet`);
  }
}

export function podName(agentId: string, generation: number): string {
  return `agent-${agentId}-g${generation}`;
}

export type { Duplex };
