/**
 * Domain contract shared by server, harness and web.
 *
 * Job role, reporting relation and capability grant are deliberately separate:
 * a title ("ceo", "leader") never grants anything on its own; only grants do.
 */

export const ACTIONS = [
  "org.view", // see an agent and its status
  "task.view",
  "task.create", // create a task whose assignee is the target
  "task.assign", // move an existing task to the target
  "task.review", // approve/reject a task in review whose assignee is the target
  "agent.spawn", // target = the manager the new agent will report to
  "agent.update", // rename / change reporting line of the target
  "agent.retire",
  "agent.configure", // choose the target's API credential, model and agent settings
  "runtime.control", // pause/resume intake, stop/start runtime of the target
  "runtime.logs",
  "runtime.exec", // interactive shell in the target's runtime: a strong permission
  "permission.delegate", // issue a grant to the target
  "code.read", // download a snapshot of a registered repository (target = self + repoId)
  "code.propose", // submit changes; the server opens a pull request, never merges
  // Organization-level rights of human users (the owner holds them implicitly).
  "credential.manage", // add / refresh / revoke the organization's LLM API keys
  "audit.view", // read the audit log
  "user.manage", // invite people, reset their tokens, edit their permissions
  "org.design", // upload art assets and edit the world (floors, rooms, objects); never permissions
] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * Scopes are evaluated relative to the grant's principal against the *current*
 * reporting graph, so a reporting change automatically re-scopes every grant.
 */
export type Scope =
  | { kind: "self" }
  | { kind: "direct-reports" }
  | { kind: "descendants" }
  | { kind: "team" } // self + descendants
  | { kind: "department" } // same department as the principal
  | { kind: "departments"; ids: string[] } // agents in these departments (for people, who sit outside the tree)
  | { kind: "org" }
  | { kind: "agents"; ids: string[] }
  | { kind: "projects"; ids: string[] };

export interface GrantConstraints {
  /** agent.spawn only: templates the principal may instantiate. */
  templates?: string[];
  /** code.* only: repository ids the principal may read / propose changes to. */
  repos?: string[];
}

export interface Grant {
  id: string;
  /** An agent id, or `user:<id>` for a person (see principalOf). */
  principalId: string;
  action: Action;
  scope: Scope;
  constraints: GrantConstraints;
  /** May the principal re-issue (a subset of) this grant to others? */
  delegable: boolean;
  /** "owner" (config / human), "template:<id>", or the delegating agent id. */
  issuer: string;
  /** Delegated grants stay valid only while their parent is valid and still covers them. */
  parentGrantId: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revision: number;
}

export interface AgentNode {
  id: string;
  departmentId: string;
  reportsToAgentId: string | null;
  lifecycleState: AgentLifecycle;
}

export type AgentLifecycle = "provisioning" | "active" | "retired";

export type Actor =
  | { kind: "human"; id: string; owner: boolean }
  | { kind: "agent"; id: string };

/**
 * The grant principal an actor's permissions are stored under. People are
 * namespaced with `user:` so they can never collide with an agent id (agent ids
 * are DNS labels and never contain a colon).
 */
export function principalOf(actor: Actor): string {
  return actor.kind === "human" ? `user:${actor.id}` : actor.id;
}

/** What an action is aimed at. agentId is the agent the action touches. */
export interface Target {
  agentId?: string;
  projectId?: string | null;
  templateId?: string;
  repoId?: string;
}

export interface Decision {
  allowed: boolean;
  reason: string;
  grantId?: string;
}

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Per-agent settings for LLM harnesses. The API key itself never appears here. */
export interface AgentConfig {
  credentialId: string | null;
  model: string | null;
  effort: Effort | null;
  instructions: string;
  maxTurns: number;
}

export const WORK_STATES = ["idle", "thinking", "executing", "waiting", "blocked", "offline", "error"] as const;
export type WorkState = (typeof WORK_STATES)[number];

export type InfraState = "none" | "pending" | "running" | "restarting" | "failed" | "stopped" | "unknown";
