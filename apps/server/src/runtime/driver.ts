import { apiProtocol, type ApiProtocol, type AuthHeader, type RuntimePreset } from "@agentown/core";
import type { Duplex, Readable, Writable } from "node:stream";

/**
 * Everything the controller needs to materialize one runtime generation. A
 * runtime is shared by a team; its members (and their model connections) are
 * learned by the runtime itself from the server, so they can change without a
 * new runtime.
 */
export interface RuntimeSpec {
  /** Workload identity (a DNS label), e.g. "team-roastery". */
  runtimeId: string;
  teamId: string;
  generation: number;
  namespace: string;
  preset: RuntimePreset;
  /** Size of this generation: the preset's base plus every member's declared share. */
  resources: { cpu: string; memory: string };
  apiUrl: string;
  storageRef: string;
  displayName: string;
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
  listPods(namespace: string, runtimeId: string): Promise<PodInfo[]>;
  /** Idempotently create the runtime's ServiceAccount, workspace volume and credential Secret. */
  ensureIdentity(spec: RuntimeSpec, issueToken: () => Promise<string>): Promise<void>;
  createPod(spec: RuntimeSpec): Promise<string>;
  deletePod(namespace: string, name: string): Promise<void>;
  /** Remove credential + identity; workspace only when purgeWorkspace. */
  teardown(namespace: string, runtimeId: string, purgeWorkspace: boolean): Promise<void>;
  exec(namespace: string, pod: string, command: string[], streams: ExecStreams): Promise<{ close: () => void }>;
}

/** The runtime's namespace does not exist (or grants us nothing) yet: the cluster provisioner has not run. */
export class NamespaceNotReady extends Error {
  constructor(readonly namespace: string) {
    super(`namespace ${namespace} is not provisioned yet`);
  }
}

export function podName(runtimeId: string, generation: number): string {
  return `agent-${runtimeId}-g${generation}`;
}

export function quantity(share: { cpu: number; memory: number }): { cpu: string; memory: string } {
  return { cpu: `${share.cpu}m`, memory: `${share.memory}Mi` };
}

export type { Duplex };
