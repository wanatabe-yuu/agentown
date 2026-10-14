import { apiProtocol, type ApiProtocol, type AuthHeader, type RuntimePreset } from "@agentown/core";
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
  /** Non-secret model connection metadata (null = none). Keys stay on the server. */
  llm: RuntimeLlm | null;
}

/** The LLM credential an agent's runtime holds. */
export interface RuntimeLlm {
  provider: string;
  /** Anthropic only: sent as the anthropic-workspace-id header when the key is not scoped to a workspace. */
  workspaceId: string | null;
  /** OpenAI-compatible providers: the Chat Completions endpoint. */
  baseUrl: string | null;
  protocol?: ApiProtocol;
  authHeader?: AuthHeader;
}

/** Runtime model traffic goes through the server. No provider secret reaches this boundary. */
export function llmEnv(llm: RuntimeLlm, apiUrl: string): { secret: Record<string, string>; plain: Record<string, string> } {
  const protocol = apiProtocol(llm.provider, llm.protocol);
  const broker = `${apiUrl.replace(/\/$/, "")}/api/runtime/llm/${protocol}`;
  return { secret: {}, plain: {
    AGENTOWN_LLM_PROVIDER: llm.provider, AGENTOWN_LLM_PROTOCOL: protocol, AGENTOWN_LLM_BROKER: "1",
    ...(protocol === "anthropic" ? { ANTHROPIC_BASE_URL: broker } : { AGENTOWN_LLM_BASE_URL: `${broker}/v1` }),
  } };
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
