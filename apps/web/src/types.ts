import type { World } from "@agentown/core/world";
export type WorkState = "idle" | "thinking" | "executing" | "waiting" | "blocked" | "offline" | "error";

export interface Agent {
  id: string;
  displayName: string;
  jobRole: string;
  departmentId: string;
  teamId: string;
  /** This member's share of its team runtime, in millicores / MiB. */
  resources: { cpu: number; memory: number; declared: boolean };
  templateId: string;
  reportsToAgentId: string | null;
  lifecycleState: "provisioning" | "active" | "retired";
  seat: number;
  acceptingWork: boolean;
  desiredRuntime: "running" | "stopped";
  work: { state: WorkState; reported: WorkState; detail: string | null; updatedAt: string | null };
  lastHeartbeatAt: string | null;
  config: AgentConfig;
  configRevision: number;
  runtime: {
    presetId: string;
    generation: number;
    namespace: string;
    workloadRef: string | null;
    state: string;
    detail: string | null;
    observedAt: string | null;
    ready: boolean;
  } | null;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentConfig {
  credentialId: string | null;
  model: string | null;
  effort: Effort | null;
  instructions: string;
  maxTurns: number;
  contextLimit: number | null;
}

export interface Credential {
  id: string;
  name: string;
  provider: string;
  keyHint: string;
  workspaceId: string | null;
  baseUrl: string | null;
  protocol: "anthropic" | "openai";
  authHeader: { name: string; scheme: "raw" | "bearer" };
  models: string[];
  departments: string[] | null;
  revision: number;
  createdAt: string;
  modelsRefreshedAt: string;
  revokedAt: string | null;
}

export interface AgentDetail extends Agent {
  credential: Credential | null;
  grants: Array<{ id: string; action: string; scope: { kind: string; ids?: string[] }; constraints: { templates?: string[] }; delegable: boolean; issuer: string; parentGrantId: string | null }>;
  can: Record<string, boolean>;
  /** Templates the caller may hire under this agent. */
  spawnTemplates: string[];
}

export interface Task {
  id: string;
  projectId: string | null;
  parentTaskId: string | null;
  title: string;
  description: string;
  acceptanceCriteria: string;
  spec: { kind: string; playbook?: string; args?: Record<string, string>; script?: string };
  status: string;
  statusReason: string | null;
  assigneeAgentId: string | null;
  createdBy: string;
  requiresReview: boolean;
  inputTaskIds: string[];
  attempt: number;
  maxAttempts: number;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetail extends Task {
  configurationChanges: Array<{ id: number; agentId: string; name: string; at: string; runId: string; linked: boolean; before: Record<string, unknown> | null; saved: Record<string, unknown>; current: Record<string, unknown>; changedSince: boolean; revision: number | null; changed: boolean | null }>;
  runs: Array<{ id: string; agent_id: string; attempt: number; runtime_generation: number; status: string; started_at: string; finished_at: string | null; summary: string | null; usage: Record<string, unknown> | null }>;
  artifacts: Array<{ id: string; name: string; content_type: string; sha256: string; size: number; created_at: string }>;
  assignments: Array<{ from_agent_id: string | null; to_agent_id: string; by_actor: string; at: string }>;
  can: { review: boolean; retry: boolean; cancel: boolean };
}

export interface TaskProgress {
  taskId: string;
  runId: string | null;
  canReadLogs: boolean;
  current: { state: string; detail: string | null; updatedAt: string | null; heartbeatAt: string | null } | null;
  events: Array<{ seq: number; at: string; type: string; message: string; detail: string | null }>;
  logs: Array<{ seq: number; at: string; stream: string; line: string }>;
}

export type Scope = { kind: string; ids?: string[] };

/** The signed-in account and the organizations it can open. */
export interface Account {
  user: { id: string; displayName: string; admin: boolean } | null;
  orgs: Array<{ id: string; name: string; owner: boolean }>;
}

/** The signed-in person inside one organization, and what they may do outside any one agent. */
export interface Me {
  organization: { id: string; name: string };
  actor: { kind: string; id: string; owner?: boolean };
  user: User | null;
  can: Record<string, boolean>;
  taskTargets: string[];
  execTargets: string[];
}

export interface Permission {
  id: string;
  action: string;
  scope: Scope;
  constraints: { templates?: string[]; repos?: string[] };
  issuer: string;
}

export interface User {
  id: string;
  displayName: string;
  roleId: string | null;
  owner: boolean;
  disabledAt: string | null;
  createdAt: string;
  permissions: Permission[];
}

export interface Role {
  id: string;
  name: string;
  permissions: Array<Omit<Permission, "id" | "issuer">>;
}

export interface Department {
  id: string;
  name: string;
  color: string;
}

export interface Snapshot {
  cursor: number;
  organization: { id: string; name: string };
  me: { kind: string; id: string };
  departments: Department[];
  teams: Team[];
  /** Latest notable events, newest first. */
  recent?: AgentEvent[];
  projects: Array<{ id: string; name: string }>;
  /** Floors, rooms and objects from the organization's template; null = one room per department. */
  world: World | null;
  agents: Agent[];
  tasks: Task[];
  serverTime: string;
}

/** A team works in one department and shares one runtime. */
export interface Team {
  id: string;
  name: string;
  departmentId: string;
  /** The department's default team (not listed in the organization's structure). */
  implicit: boolean;
  memberIds: string[];
  runtime: { presetId: string; generation: number; state: string; detail: string | null; ready: boolean; resources: { cpu: number; memory: number } | null } | null;
}

export interface TeamMessage {
  id: string;
  at: string;
  author: { kind: "human" | "agent"; id: string; name: string };
  text: string;
  system: boolean;
  event?: AgentEvent;
}

export type FeedKind = "self" | "tool" | "proposal" | "event";

export interface FeedItem {
  id: string;
  at: string;
  kind: FeedKind;
  agentId: string | null;
  teamId: string | null;
  title: string;
  text: string;
  status?: string;
  taskId?: string | null;
  proposalId?: string;
  canDecide?: boolean;
  event?: AgentEvent;
}

export interface AgentEvent {
  seq: number;
  at: string;
  agentId: string | null;
  taskId: string | null;
  runId: string | null;
  type: string;
  payload: Record<string, any>;
}

export interface Catalog {
  templates: Array<{ id: string; jobRole: string; runtimePreset: string; policyProfile: string }>;
  presets: Array<{ id: string; harness: string; image: string; placement?: string; resources?: { cpu: string; memory: string }; member?: { cpu: string; memory: string } }>;
  departments: Department[];
  projects: Array<{ id: string; name: string }>;
  providers?: ProviderInfo[];
}

export interface ProviderInfo {
  id: string;
  label: string;
  baseUrl: string | null;
  keyRequired: boolean;
  keyPlaceholder: string;
}

export interface Proposal {
  id: string;
  kind: "capability_call" | "config_change" | "task_result" | "world_change" | "permission_change" | "runtime_change" | "team_change";
  title: string;
  proposer: string;
  subject: { type: string; id: string } | null;
  payload: Record<string, any>;
  status: string;
  createdAt: string;
  canDecide: boolean;
}
