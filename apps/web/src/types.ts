export type WorkState = "idle" | "thinking" | "executing" | "waiting" | "blocked" | "offline" | "error";

export interface Agent {
  id: string;
  displayName: string;
  jobRole: string;
  departmentId: string;
  templateId: string;
  reportsToAgentId: string | null;
  lifecycleState: "provisioning" | "active" | "retired";
  seat: number;
  acceptingWork: boolean;
  desiredRuntime: "running" | "stopped";
  work: { state: WorkState; reported: WorkState; detail: string | null; updatedAt: string | null };
  lastHeartbeatAt: string | null;
  config: AgentConfig;
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
}

export interface Credential {
  id: string;
  name: string;
  provider: string;
  keyHint: string;
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
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetail extends Task {
  runs: Array<{ id: string; agent_id: string; attempt: number; runtime_generation: number; status: string; started_at: string; finished_at: string | null; summary: string | null; usage: Record<string, unknown> | null }>;
  artifacts: Array<{ id: string; name: string; content_type: string; sha256: string; size: number; created_at: string }>;
  assignments: Array<{ from_agent_id: string | null; to_agent_id: string; by_actor: string; at: string }>;
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
  projects: Array<{ id: string; name: string }>;
  agents: Agent[];
  tasks: Task[];
  serverTime: string;
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
  presets: Array<{ id: string; harness: string; image: string; placement?: string }>;
  departments: Department[];
  projects: Array<{ id: string; name: string }>;
}
