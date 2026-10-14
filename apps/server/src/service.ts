import {
  type Action,
  type Actor,
  type AgentNode,
  type Grant,
  type GrantConstraints,
  type OrgConfig,
  type PolicyContext,
  type Scope,
  type TaskSpec,
  type TaskStatus,
  type Target,
  type WorkState,
  OrgGraph,
  PLAYBOOK_ARG_NAME,
  PLAYBOOK_NAME,
  WORK_STATES,
  authorize,
  canDelegate,
  canTransition,
  isTerminal,
} from "@agentown/core";
import type pg from "pg";
import type { AgentEventRow, EventBus } from "./bus.ts";
import { type Db, type Queryable, tx } from "./db.ts";
import {
  ApiError,
  actorRef,
  badRequest,
  conflict,
  deny,
  newId,
  newSecret,
  notFound,
  redactLine,
  sanitize,
  sha256,
} from "./util.ts";

const LEASE_SECONDS = 60;
const HEARTBEAT_STALE_MS = 45_000;
const TICKET_TTL_MS = 30_000;

export interface AgentRow {
  id: string;
  department_id: string;
  display_name: string;
  job_role: string;
  template_id: string;
  reports_to: string | null;
  lifecycle_state: "provisioning" | "active" | "retired";
  desired_runtime: "running" | "stopped";
  accepting_work: boolean;
  created_by: string;
  seat: number;
  work_state: WorkState;
  work_detail: string | null;
  work_updated_at: Date | null;
  last_heartbeat_at: Date | null;
  created_at: Date;
}

export interface RuntimeRow {
  agent_id: string;
  preset_id: string;
  generation: number;
  namespace: string;
  workload_ref: string | null;
  storage_ref: string | null;
  observed_state: string;
  observed_detail: string | null;
  observed_at: Date | null;
  ready_generation: number | null;
}

export interface TaskRow {
  id: string;
  project_id: string | null;
  parent_task_id: string | null;
  title: string;
  description: string;
  acceptance_criteria: string;
  spec: TaskSpec;
  status: TaskStatus;
  status_reason: string | null;
  assignee_agent_id: string | null;
  created_by: string;
  requires_review: boolean;
  input_task_ids: string[];
  attempt: number;
  max_attempts: number;
  summary: string | null;
  created_at: Date;
  updated_at: Date;
}

interface GrantRow {
  id: string;
  principal_id: string;
  action: Action;
  scope: Scope;
  constraints: GrantConstraints;
  delegable: boolean;
  issuer: string;
  parent_grant_id: string | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  revision: number;
}

interface Ctx {
  c: pg.PoolClient;
  events: AgentEventRow[];
}

interface EventInput {
  type: string;
  agentId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  payload?: Record<string, unknown>;
}

export interface LoadedPolicy extends PolicyContext {
  revision: number;
}

export function namespaceFor(departmentId: string): string {
  return `agentown-${departmentId}`;
}

function toGrant(r: GrantRow): Grant {
  return {
    id: r.id,
    principalId: r.principal_id,
    action: r.action,
    scope: r.scope,
    constraints: r.constraints ?? {},
    delegable: r.delegable,
    issuer: r.issuer,
    parentGrantId: r.parent_grant_id,
    expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
    revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
    revision: r.revision,
  };
}

/**
 * Organization service: every mutation goes through here, is authorized against
 * the authenticated actor (never a client-supplied id), audited, and emits events
 * only after its transaction commits.
 */
export class Service {
  constructor(
    readonly db: Db,
    readonly config: OrgConfig,
    readonly bus: EventBus,
  ) {}

  // ---------------------------------------------------------------- plumbing

  private async withTx<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
    const events: AgentEventRow[] = [];
    const out = await tx(this.db, (c) => fn({ c, events }));
    this.bus.publish(events);
    return out;
  }

  private async emit(ctx: Ctx, e: EventInput): Promise<void> {
    const { rows } = await ctx.c.query(
      `INSERT INTO agent_events(agent_id, task_id, run_id, type, payload) VALUES ($1,$2,$3,$4,$5)
       RETURNING seq, at`,
      [e.agentId ?? null, e.taskId ?? null, e.runId ?? null, e.type, JSON.stringify(sanitize(e.payload ?? {}))],
    );
    ctx.events.push({
      seq: Number(rows[0].seq),
      at: rows[0].at.toISOString(),
      agentId: e.agentId ?? null,
      taskId: e.taskId ?? null,
      runId: e.runId ?? null,
      type: e.type,
      payload: sanitize(e.payload ?? {}) as Record<string, unknown>,
    });
  }

  async audit(
    q: Queryable,
    actor: Actor | string,
    action: string,
    target: string | null,
    allowed: boolean,
    reason: string,
    detail: Record<string, unknown> = {},
    revision?: number,
  ): Promise<void> {
    await q.query(
      `INSERT INTO audit_events(actor, action, target, allowed, reason, policy_revision, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        typeof actor === "string" ? actor : actorRef(actor),
        action,
        target,
        allowed,
        reason,
        revision ?? null,
        JSON.stringify(sanitize(detail)),
      ],
    );
  }

  private async bumpRevision(q: Queryable): Promise<void> {
    await q.query("UPDATE organizations SET policy_revision = policy_revision + 1");
  }

  async loadPolicy(q: Queryable = this.db): Promise<LoadedPolicy> {
    const [agents, grants, org] = await Promise.all([
      q.query<{ id: string; department_id: string; reports_to: string | null; lifecycle_state: AgentNode["lifecycleState"] }>(
        "SELECT id, department_id, reports_to, lifecycle_state FROM agents",
      ),
      q.query<GrantRow>("SELECT * FROM grants WHERE revoked_at IS NULL"),
      q.query<{ policy_revision: string }>("SELECT policy_revision FROM organizations LIMIT 1"),
    ]);
    return {
      graph: new OrgGraph(
        agents.rows.map((a) => ({
          id: a.id,
          departmentId: a.department_id,
          reportsToAgentId: a.reports_to,
          lifecycleState: a.lifecycle_state,
        })),
      ),
      grants: grants.rows.map(toGrant),
      revision: Number(org.rows[0]?.policy_revision ?? 0),
    };
  }

  /** Authorize or throw 403. Every decision on a mutating action is audited, denials included. */
  async require(
    actor: Actor,
    action: Action,
    target: Target,
    opts: { policy?: LoadedPolicy; q?: Queryable; auditAs?: string; detail?: Record<string, unknown> } = {},
  ): Promise<LoadedPolicy> {
    const policy = opts.policy ?? (await this.loadPolicy(opts.q));
    const d = authorize(actor, action, target, policy);
    const mutating = !action.endsWith(".view") && action !== "runtime.logs";
    if (mutating || !d.allowed) {
      // Denials are written outside the caller's transaction, which is about to roll back.
      await this.audit(
        d.allowed ? (opts.q ?? this.db) : this.db,
        actor,
        opts.auditAs ?? action,
        target.agentId ?? target.projectId ?? null,
        d.allowed,
        d.reason,
        { ...opts.detail, templateId: target.templateId },
        policy.revision,
      );
    }
    if (!d.allowed) throw deny(`${action} denied: ${d.reason}`);
    return policy;
  }

  // ---------------------------------------------------------------- auth

  async authenticate(token: string | undefined): Promise<Actor | null> {
    if (!token) return null;
    const { rows } = await this.db.query<{ principal_kind: string; principal_id: string }>(
      "SELECT principal_kind, principal_id FROM tokens WHERE hash = $1 AND revoked_at IS NULL",
      [sha256(token)],
    );
    const r = rows[0];
    if (!r) return null;
    if (r.principal_kind === "human") return { kind: "human", id: r.principal_id, role: "owner" };
    return { kind: "agent", id: r.principal_id };
  }

  async issueToken(q: Queryable, kind: "human" | "agent", principalId: string, label: string, rotate: boolean): Promise<string> {
    if (rotate) {
      await q.query("UPDATE tokens SET revoked_at = now() WHERE principal_kind=$1 AND principal_id=$2 AND revoked_at IS NULL", [
        kind,
        principalId,
      ]);
    }
    const token = `${kind === "human" ? "aho" : "aag"}_${newSecret()}`;
    await q.query("INSERT INTO tokens(hash, principal_kind, principal_id, label) VALUES ($1,$2,$3,$4)", [
      sha256(token),
      kind,
      principalId,
      label,
    ]);
    return token;
  }

  /** Called by the runtime controller when it (re)creates an agent's credential Secret. */
  async issueAgentToken(agentId: string): Promise<string> {
    const token = await this.issueToken(this.db, "agent", agentId, "runtime", true);
    await this.audit(this.db, "system:controller", "token.issue", agentId, true, "runtime credential (re)created");
    return token;
  }

  // ---------------------------------------------------------------- bootstrap

  /** Idempotently load the owner-authored config. Returns a fresh owner token only on first boot. */
  async bootstrap(opts: { ownerToken?: string } = {}): Promise<{ ownerToken: string | null }> {
    return this.withTx(async (ctx) => {
      const { c } = ctx;
      const cfg = this.config;
      await c.query(
        `INSERT INTO organizations(id, name) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [cfg.organization.id, cfg.organization.name],
      );
      for (const d of cfg.departments) {
        await c.query(
          `INSERT INTO departments(id, name, color) VALUES ($1,$2,$3)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color`,
          [d.id, d.name, d.color],
        );
      }
      for (const p of cfg.projects) {
        await c.query(`INSERT INTO projects(id, name) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`, [
          p.id,
          p.name,
        ]);
      }
      for (const a of cfg.bootstrap.agents) {
        const exists = await c.query("SELECT 1 FROM agents WHERE id = $1", [a.key]);
        if (exists.rowCount) continue;
        await this.insertAgent(ctx, {
          id: a.key,
          templateId: a.template,
          displayName: a.displayName,
          departmentId: a.department,
          reportsTo: a.reportsTo,
          createdBy: "owner:config",
          spawnKey: null,
        });
      }
      let ownerToken: string | null = null;
      const owners = await c.query("SELECT 1 FROM tokens WHERE principal_kind='human' AND revoked_at IS NULL");
      if (!owners.rowCount) {
        if (opts.ownerToken) {
          await c.query("INSERT INTO tokens(hash, principal_kind, principal_id, label) VALUES ($1,'human','owner','bootstrap')", [
            sha256(opts.ownerToken),
          ]);
          ownerToken = opts.ownerToken;
        } else {
          ownerToken = await this.issueToken(c, "human", "owner", "bootstrap", false);
        }
      }
      return { ownerToken };
    });
  }

  private template(id: string) {
    const t = this.config.agentTemplates.find((x) => x.id === id);
    if (!t) throw badRequest(`unknown template ${id}`);
    const preset = this.config.runtimeCatalog.find((p) => p.id === t.runtimePreset)!;
    return { template: t, preset, profile: this.config.policyProfiles[t.policyProfile]! };
  }

  private async insertAgent(
    ctx: Ctx,
    a: {
      id: string;
      templateId: string;
      displayName: string;
      departmentId: string;
      reportsTo: string | null;
      createdBy: string;
      spawnKey: string | null;
    },
  ): Promise<void> {
    const { template, preset, profile } = this.template(a.templateId);
    const seat = await ctx.c.query<{ n: string }>("SELECT count(*) AS n FROM agents WHERE department_id = $1", [a.departmentId]);
    await ctx.c.query(
      `INSERT INTO agents(id, department_id, display_name, job_role, template_id, reports_to, lifecycle_state,
         desired_runtime, created_by, spawn_key, seat)
       VALUES ($1,$2,$3,$4,$5,$6,'provisioning','running',$7,$8,$9)`,
      [a.id, a.departmentId, a.displayName, template.jobRole, template.id, a.reportsTo, a.createdBy, a.spawnKey, Number(seat.rows[0]!.n)],
    );
    await ctx.c.query(
      `INSERT INTO agent_runtimes(agent_id, preset_id, namespace, storage_ref) VALUES ($1,$2,$3,$4)`,
      [a.id, preset.id, namespaceFor(a.departmentId), `agent-${a.id}-workspace`],
    );
    // Template grants were approved by the owner when they authored the config;
    // the spawner can only pick templates its own agent.spawn grant lists.
    for (const cap of profile) {
      await ctx.c.query(
        `INSERT INTO grants(id, principal_id, action, scope, constraints, delegable, issuer)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          newId("g"),
          a.id,
          cap.action,
          JSON.stringify(cap.scope),
          JSON.stringify(cap.templates ? { templates: cap.templates } : {}),
          cap.delegable,
          `template:${template.id}`,
        ],
      );
    }
    await this.bumpRevision(ctx.c);
    await this.emit(ctx, {
      type: "agent.spawned",
      agentId: a.id,
      payload: { displayName: a.displayName, jobRole: template.jobRole, departmentId: a.departmentId, reportsTo: a.reportsTo, createdBy: a.createdBy },
    });
  }

  // ---------------------------------------------------------------- agents

  async getAgentRow(id: string, q: Queryable = this.db): Promise<AgentRow> {
    const { rows } = await q.query<AgentRow>("SELECT * FROM agents WHERE id = $1", [id]);
    if (!rows[0]) throw notFound("agent");
    return rows[0];
  }

  async getRuntimeRow(id: string, q: Queryable = this.db): Promise<RuntimeRow> {
    const { rows } = await q.query<RuntimeRow>("SELECT * FROM agent_runtimes WHERE agent_id = $1", [id]);
    if (!rows[0]) throw notFound("runtime");
    return rows[0];
  }

  async spawn(
    actor: Actor,
    input: { templateId: string; displayName: string; reportsToAgentId: string | null; departmentId?: string; idempotencyKey?: string },
  ): Promise<{ agent: ReturnType<Service["presentAgent"]>; existing: boolean }> {
    this.template(input.templateId);
    const spawnKey = input.idempotencyKey ? `${actorRef(actor)}:${input.idempotencyKey}` : null;
    if (spawnKey) {
      const { rows } = await this.db.query<AgentRow>("SELECT * FROM agents WHERE spawn_key = $1", [spawnKey]);
      if (rows[0]) {
        if (rows[0].template_id !== input.templateId || rows[0].reports_to !== input.reportsToAgentId) {
          throw conflict("idempotency_mismatch", "idempotency key reused with different parameters");
        }
        return { agent: await this.presentAgentById(rows[0].id), existing: true };
      }
    }
    if (actor.kind === "agent" && !input.reportsToAgentId) throw deny("agents must place new hires under a manager");

    const id = await this.withTx(async (ctx) => {
      const policy = await this.loadPolicy(ctx.c);
      let departmentId = input.departmentId;
      if (input.reportsToAgentId) {
        const manager = await this.getAgentRow(input.reportsToAgentId, ctx.c);
        if (manager.lifecycle_state === "retired") throw conflict("manager_retired", "manager is retired");
        departmentId ??= manager.department_id;
        if (actor.kind === "agent" && departmentId !== manager.department_id) {
          throw deny("agents can only spawn into the manager's department");
        }
      }
      if (!departmentId) throw badRequest("departmentId required when there is no manager");
      if (!this.config.departments.some((d) => d.id === departmentId)) throw badRequest("unknown department");
      await this.require(
        actor,
        "agent.spawn",
        { agentId: input.reportsToAgentId ?? undefined, templateId: input.templateId },
        { policy, q: ctx.c, detail: { displayName: input.displayName } },
      );
      const id = newId("a", 4);
      await this.insertAgent(ctx, {
        id,
        templateId: input.templateId,
        displayName: input.displayName.slice(0, 40),
        departmentId,
        reportsTo: input.reportsToAgentId,
        createdBy: actorRef(actor),
        spawnKey,
      });
      return id;
    });
    return { agent: await this.presentAgentById(id), existing: false };
  }

  async presentAgentById(id: string) {
    const [a, r] = await Promise.all([this.getAgentRow(id), this.getRuntimeRow(id)]);
    return this.presentAgent(a, r);
  }

  presentAgent(a: AgentRow, r: RuntimeRow | undefined) {
    const now = Date.now();
    const ready = !!r && r.observed_state === "running" && r.ready_generation === r.generation;
    const stale = !a.last_heartbeat_at || now - a.last_heartbeat_at.getTime() > HEARTBEAT_STALE_MS;
    // Work state shown on the character is only what the harness reported, and
    // only while the runtime is actually up and heartbeating.
    let workState: WorkState = a.work_state;
    if (a.lifecycle_state === "retired" || !ready || stale) workState = r?.observed_state === "failed" ? "error" : "offline";
    return {
      id: a.id,
      displayName: a.display_name,
      jobRole: a.job_role,
      departmentId: a.department_id,
      templateId: a.template_id,
      reportsToAgentId: a.reports_to,
      lifecycleState: a.lifecycle_state,
      seat: a.seat,
      acceptingWork: a.accepting_work,
      desiredRuntime: a.desired_runtime,
      work: { state: workState, reported: a.work_state, detail: a.work_detail, updatedAt: a.work_updated_at?.toISOString() ?? null },
      lastHeartbeatAt: a.last_heartbeat_at?.toISOString() ?? null,
      runtime: r
        ? {
            presetId: r.preset_id,
            generation: r.generation,
            namespace: r.namespace,
            workloadRef: r.workload_ref,
            storageRef: r.storage_ref,
            state: r.observed_state,
            detail: r.observed_detail,
            observedAt: r.observed_at?.toISOString() ?? null,
            ready,
          }
        : null,
    };
  }

  async listAgents(actor: Actor) {
    const policy = await this.loadPolicy();
    const [{ rows: agents }, { rows: runtimes }] = await Promise.all([
      this.db.query<AgentRow>("SELECT * FROM agents ORDER BY created_at"),
      this.db.query<RuntimeRow>("SELECT * FROM agent_runtimes"),
    ]);
    const rt = new Map(runtimes.map((r) => [r.agent_id, r]));
    return agents
      .filter((a) => authorize(actor, "org.view", { agentId: a.id }, policy).allowed)
      .map((a) => this.presentAgent(a, rt.get(a.id)));
  }

  async getAgent(actor: Actor, id: string) {
    await this.getAgentRow(id);
    const policy = await this.require(actor, "org.view", { agentId: id });
    const agent = await this.presentAgentById(id);
    const grants = policy.grants.filter((g) => g.principalId === id);
    // Tell the caller what *they* may do to this agent, so the UI can show/hide
    // controls. The server still re-checks every call.
    const can: Partial<Record<Action, boolean>> = {};
    for (const a of ["task.create", "task.assign", "runtime.control", "runtime.logs", "runtime.exec", "agent.update", "agent.retire", "permission.delegate"] as const) {
      can[a] = authorize(actor, a, { agentId: id }, policy).allowed;
    }
    can["agent.spawn"] = this.config.agentTemplates.some(
      (t) => authorize(actor, "agent.spawn", { agentId: id, templateId: t.id }, policy).allowed,
    );
    return { ...agent, grants, can };
  }

  async updateAgent(actor: Actor, id: string, input: { displayName?: string; reportsToAgentId?: string | null }) {
    await this.withTx(async (ctx) => {
      const agent = await this.getAgentRow(id, ctx.c);
      const policy = await this.require(actor, "agent.update", { agentId: id }, { q: ctx.c, detail: input });
      if (input.reportsToAgentId !== undefined && input.reportsToAgentId !== agent.reports_to) {
        if (input.reportsToAgentId === null) {
          if (actor.kind !== "human") throw deny("only the owner can detach an agent from the tree");
        } else {
          await this.getAgentRow(input.reportsToAgentId, ctx.c);
          // Moving someone under a new manager needs authority over that manager too.
          await this.require(actor, "agent.update", { agentId: input.reportsToAgentId }, { policy, q: ctx.c, auditAs: "agent.update.manager" });
          if (policy.graph.wouldCreateCycle(id, input.reportsToAgentId)) throw conflict("cycle", "reporting relation would create a cycle");
        }
        await ctx.c.query("UPDATE agents SET reports_to = $2 WHERE id = $1", [id, input.reportsToAgentId]);
        await this.bumpRevision(ctx.c);
      }
      if (input.displayName) await ctx.c.query("UPDATE agents SET display_name = $2 WHERE id = $1", [id, input.displayName.slice(0, 40)]);
      await this.emit(ctx, { type: "agent.updated", agentId: id, payload: input });
    });
    return this.presentAgentById(id);
  }

  async setIntake(actor: Actor, id: string, accepting: boolean) {
    await this.withTx(async (ctx) => {
      await this.getAgentRow(id, ctx.c);
      await this.require(actor, "runtime.control", { agentId: id }, { q: ctx.c, auditAs: accepting ? "agent.resume" : "agent.pause" });
      await ctx.c.query("UPDATE agents SET accepting_work = $2 WHERE id = $1", [id, accepting]);
      await this.emit(ctx, { type: "agent.intake", agentId: id, payload: { acceptingWork: accepting } });
    });
    return this.presentAgentById(id);
  }

  /** start/stop set desired state; restart bumps the generation so the controller replaces the pod. */
  async setRuntime(actor: Actor, id: string, op: "start" | "stop" | "restart") {
    await this.withTx(async (ctx) => {
      const agent = await this.getAgentRow(id, ctx.c);
      if (agent.lifecycle_state === "retired") throw conflict("retired", "agent is retired");
      await this.require(actor, "runtime.control", { agentId: id }, { q: ctx.c, auditAs: `runtime.${op}` });
      if (op === "stop") {
        await ctx.c.query("UPDATE agents SET desired_runtime='stopped' WHERE id=$1", [id]);
        // Work in flight on the stopped runtime is abandoned and requeued.
        await this.bumpGeneration(ctx, id, `stop requested by ${actorRef(actor)}`);
      } else {
        await ctx.c.query("UPDATE agents SET desired_runtime='running' WHERE id=$1", [id]);
        // start after a failure and restart both mean "new runtime generation".
        const rt = await this.getRuntimeRow(id, ctx.c);
        if (op === "restart" || rt.observed_state === "failed") await this.bumpGeneration(ctx, id, `${op} requested by ${actorRef(actor)}`);
      }
      await this.emit(ctx, { type: "runtime.desired", agentId: id, payload: { op } });
    });
    return this.presentAgentById(id);
  }

  /** New runtime generation: runs bound to the old one can no longer report or complete. */
  async bumpGeneration(ctx: Ctx, agentId: string, reason: string): Promise<number> {
    const { rows } = await ctx.c.query<{ generation: number }>(
      "UPDATE agent_runtimes SET generation = generation + 1, ready_generation = NULL WHERE agent_id = $1 RETURNING generation",
      [agentId],
    );
    const gen = rows[0]!.generation;
    const lost = await ctx.c.query<{ id: string; task_id: string }>(
      "UPDATE task_runs SET status='lost', finished_at=now(), summary=$2 WHERE agent_id=$1 AND status='running' RETURNING id, task_id",
      [agentId, `runtime replaced (${reason})`],
    );
    for (const r of lost.rows) await this.requeueAfterLostRun(ctx, r.task_id, r.id, "runtime replaced");
    await this.emit(ctx, { type: "runtime.generation", agentId, payload: { generation: gen, reason } });
    return gen;
  }

  private async requeueAfterLostRun(ctx: Ctx, taskId: string, runId: string, why: string) {
    const { rows } = await ctx.c.query<TaskRow>("SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [taskId]);
    const t = rows[0];
    if (!t || t.status !== "in_progress") return;
    if (t.attempt >= t.max_attempts) {
      await this.setTaskStatus(ctx, t, "failed", `${why}; gave up after ${t.attempt} attempts`);
    } else {
      await ctx.c.query("UPDATE tasks SET attempt = attempt + 1 WHERE id=$1", [taskId]);
      await this.setTaskStatus(ctx, t, "assigned", `${why}; retrying (attempt ${t.attempt + 1})`);
    }
    await this.emit(ctx, { type: "run.lost", agentId: t.assignee_agent_id, taskId, runId, payload: { why } });
  }

  async retire(actor: Actor, id: string, purgeWorkspace: boolean) {
    await this.withTx(async (ctx) => {
      const agent = await this.getAgentRow(id, ctx.c);
      if (agent.lifecycle_state === "retired") return;
      await this.require(actor, "agent.retire", { agentId: id }, { q: ctx.c, detail: { purgeWorkspace } });
      const reports = await ctx.c.query("SELECT 1 FROM agents WHERE reports_to=$1 AND lifecycle_state <> 'retired'", [id]);
      if (reports.rowCount) throw conflict("has_reports", "reassign direct reports before retiring this agent");
      await ctx.c.query(
        "UPDATE agents SET lifecycle_state='retired', desired_runtime='stopped', accepting_work=false, retired_at=now() WHERE id=$1",
        [id],
      );
      await ctx.c.query("UPDATE agent_runtimes SET storage_ref = CASE WHEN $2 THEN NULL ELSE storage_ref END WHERE agent_id=$1", [
        id,
        purgeWorkspace,
      ]);
      await ctx.c.query("UPDATE tokens SET revoked_at=now() WHERE principal_kind='agent' AND principal_id=$1 AND revoked_at IS NULL", [id]);
      await this.bumpRevision(ctx.c);
      await this.emit(ctx, { type: "agent.retired", agentId: id, payload: { purgeWorkspace } });
    });
    return this.presentAgentById(id);
  }

  async logs(actor: Actor, id: string, after: number) {
    await this.getAgentRow(id);
    await this.require(actor, "runtime.logs", { agentId: id });
    const { rows } = await this.db.query(
      "SELECT seq, at, run_id, stream, line FROM agent_logs WHERE agent_id=$1 AND seq > $2 ORDER BY seq LIMIT 500",
      [id, after],
    );
    return rows.map((r) => ({ seq: Number(r.seq), at: r.at, runId: r.run_id, stream: r.stream, line: r.line }));
  }

  // ---------------------------------------------------------------- grants

  async delegate(
    actor: Actor,
    input: { principalId: string; action: Action; scope: Scope; constraints?: GrantConstraints; delegable?: boolean; expiresAt?: string | null },
  ) {
    return this.withTx(async (ctx) => {
      await this.getAgentRow(input.principalId, ctx.c);
      const policy = await this.loadPolicy(ctx.c);
      const proposed = {
        principalId: input.principalId,
        action: input.action,
        scope: input.scope,
        constraints: input.constraints ?? {},
        delegable: input.delegable ?? false,
      };
      const d = canDelegate(actor, proposed, policy);
      await this.audit(d.allowed ? ctx.c : this.db, actor, "permission.delegate", input.principalId, d.allowed, d.reason, { ...proposed }, policy.revision);
      if (!d.allowed) throw deny(`permission.delegate denied: ${d.reason}`);
      const id = newId("g");
      await ctx.c.query(
        `INSERT INTO grants(id, principal_id, action, scope, constraints, delegable, issuer, parent_grant_id, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          proposed.principalId,
          proposed.action,
          JSON.stringify(proposed.scope),
          JSON.stringify(proposed.constraints),
          proposed.delegable,
          actor.kind === "human" ? "owner" : actor.id,
          d.parentGrantId,
          input.expiresAt ?? null,
        ],
      );
      await this.bumpRevision(ctx.c);
      await this.emit(ctx, { type: "grant.created", agentId: input.principalId, payload: { grantId: id, action: input.action, scope: input.scope } });
      return { id };
    });
  }

  async revokeGrant(actor: Actor, grantId: string) {
    await this.withTx(async (ctx) => {
      const { rows } = await ctx.c.query<GrantRow>("SELECT * FROM grants WHERE id=$1", [grantId]);
      const g = rows[0];
      if (!g) throw notFound("grant");
      const allowed = actor.kind === "human" || g.issuer === actor.id;
      await this.audit(allowed ? ctx.c : this.db, actor, "permission.revoke", g.principal_id, allowed, allowed ? "owner or issuer" : "only the owner or the issuer may revoke", {
        grantId,
      });
      if (!allowed) throw deny("permission.revoke denied: only the owner or the issuer may revoke");
      await ctx.c.query("UPDATE grants SET revoked_at = now(), revision = revision + 1 WHERE id=$1 AND revoked_at IS NULL", [grantId]);
      await this.bumpRevision(ctx.c);
      await this.emit(ctx, { type: "grant.revoked", agentId: g.principal_id, payload: { grantId, action: g.action } });
    });
  }

  // ---------------------------------------------------------------- tasks

  private async getTaskRow(id: string, q: Queryable = this.db, lock = false): Promise<TaskRow> {
    const { rows } = await q.query<TaskRow>(`SELECT * FROM tasks WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`, [id]);
    if (!rows[0]) throw notFound("task");
    return rows[0];
  }

  /** Tasks whose ids appear in input_task_ids of a task assigned to the actor (explicit sharing). */
  private async sharedTaskIds(actor: Actor, q: Queryable = this.db): Promise<Set<string>> {
    if (actor.kind !== "agent") return new Set();
    const { rows } = await q.query<{ id: string }>(
      "SELECT DISTINCT unnest(input_task_ids) AS id FROM tasks WHERE assignee_agent_id = $1",
      [actor.id],
    );
    return new Set(rows.map((r) => r.id));
  }

  private canViewTask(actor: Actor, t: TaskRow, policy: PolicyContext, shared: Set<string>): boolean {
    if (actor.kind === "human") return true;
    if (t.assignee_agent_id === actor.id || t.created_by === actorRef(actor)) return true;
    if (shared.has(t.id)) return true;
    return authorize(actor, "task.view", { agentId: t.assignee_agent_id ?? undefined, projectId: t.project_id }, policy).allowed;
  }

  async requireTaskView(actor: Actor, id: string, q: Queryable = this.db): Promise<TaskRow> {
    const t = await this.getTaskRow(id, q);
    const policy = await this.loadPolicy(q);
    if (!this.canViewTask(actor, t, policy, await this.sharedTaskIds(actor, q))) {
      await this.audit(this.db, actor, "task.view", id, false, "not visible to actor");
      throw deny("task.view denied: task is not visible to you");
    }
    return t;
  }

  presentTask(t: TaskRow) {
    return {
      id: t.id,
      projectId: t.project_id,
      parentTaskId: t.parent_task_id,
      title: t.title,
      description: t.description,
      acceptanceCriteria: t.acceptance_criteria,
      spec: t.spec,
      status: t.status,
      statusReason: t.status_reason,
      assigneeAgentId: t.assignee_agent_id,
      createdBy: t.created_by,
      requiresReview: t.requires_review,
      inputTaskIds: t.input_task_ids,
      attempt: t.attempt,
      summary: t.summary,
      createdAt: t.created_at.toISOString(),
      updatedAt: t.updated_at.toISOString(),
    };
  }

  private validateSpec(spec: unknown): TaskSpec {
    const s = (spec ?? { kind: "prompt" }) as TaskSpec;
    if (s.kind === "prompt") return { kind: "prompt" };
    if (s.kind === "script") {
      if (typeof s.script !== "string" || !s.script.trim() || s.script.length > 20_000) throw badRequest("invalid script");
      return { kind: "script", script: s.script };
    }
    if (s.kind === "playbook") {
      if (!PLAYBOOK_NAME.test(s.playbook ?? "")) throw badRequest("invalid playbook name");
      const args: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.args ?? {})) {
        if (!PLAYBOOK_ARG_NAME.test(k) || typeof v !== "string" || v.length > 4000) throw badRequest(`invalid playbook arg ${k}`);
        args[k] = v;
      }
      return { kind: "playbook", playbook: s.playbook, args };
    }
    throw badRequest("unknown spec kind");
  }

  async createTask(
    actor: Actor,
    input: {
      title: string;
      description?: string;
      acceptanceCriteria?: string;
      assigneeAgentId?: string | null;
      projectId?: string | null;
      parentTaskId?: string | null;
      spec?: unknown;
      inputTaskIds?: string[];
      requiresReview?: boolean;
      idempotencyKey?: string;
    },
  ) {
    const spec = this.validateSpec(input.spec);
    const key = input.idempotencyKey ? `${actorRef(actor)}:${input.idempotencyKey}` : null;
    if (key) {
      const { rows } = await this.db.query<TaskRow>("SELECT * FROM tasks WHERE idempotency_key=$1", [key]);
      if (rows[0]) return { task: this.presentTask(rows[0]), existing: true };
    }
    const id = await this.withTx(async (ctx) => {
      const policy = await this.loadPolicy(ctx.c);
      const assignee = input.assigneeAgentId ?? null;
      if (!assignee && actor.kind !== "human") throw badRequest("agents must name an assignee");
      if (input.projectId && !this.config.projects.some((p) => p.id === input.projectId)) throw badRequest("unknown project");
      if (assignee) {
        const a = await this.getAgentRow(assignee, ctx.c);
        if (a.lifecycle_state === "retired") throw conflict("retired", "assignee is retired");
        await this.require(actor, "task.create", { agentId: assignee, projectId: input.projectId ?? null }, { policy, q: ctx.c, detail: { title: input.title } });
        // Inline shell runs with the assignee's identity and data: treat it as exec.
        if (spec.kind === "script" && !(actor.kind === "agent" && actor.id === assignee)) {
          await this.require(actor, "runtime.exec", { agentId: assignee }, { policy, q: ctx.c, auditAs: "task.create.script" });
        }
      }
      const shared = await this.sharedTaskIds(actor, ctx.c);
      for (const ref of [...(input.inputTaskIds ?? []), ...(input.parentTaskId ? [input.parentTaskId] : [])]) {
        const t = await this.getTaskRow(ref, ctx.c);
        if (!this.canViewTask(actor, t, policy, shared)) throw deny(`cannot reference task ${ref}: not visible to you`);
      }
      const id = newId("t");
      await ctx.c.query(
        `INSERT INTO tasks(id, project_id, parent_task_id, title, description, acceptance_criteria, spec, status,
           assignee_agent_id, created_by, requires_review, input_task_ids, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          id,
          input.projectId ?? null,
          input.parentTaskId ?? null,
          input.title.slice(0, 200),
          input.description ?? "",
          input.acceptanceCriteria ?? "",
          JSON.stringify(spec),
          assignee ? "assigned" : "queued",
          assignee,
          actorRef(actor),
          input.requiresReview ?? actor.kind === "human",
          input.inputTaskIds ?? [],
          key,
        ],
      );
      if (assignee) {
        await ctx.c.query("INSERT INTO task_assignments(task_id, to_agent_id, by_actor) VALUES ($1,$2,$3)", [id, assignee, actorRef(actor)]);
      }
      await this.emit(ctx, {
        type: "task.created",
        agentId: assignee,
        taskId: id,
        payload: { title: input.title, assignee, createdBy: actorRef(actor), projectId: input.projectId ?? null },
      });
      return id;
    });
    return { task: this.presentTask(await this.getTaskRow(id)), existing: false };
  }

  async listTasks(actor: Actor, filter: { assignee?: string; status?: string } = {}) {
    const policy = await this.loadPolicy();
    const shared = await this.sharedTaskIds(actor);
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter.assignee) where.push(`assignee_agent_id = $${params.push(filter.assignee)}`);
    if (filter.status) where.push(`status = $${params.push(filter.status)}`);
    const { rows } = await this.db.query<TaskRow>(
      `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT 500`,
      params,
    );
    return rows.filter((t) => this.canViewTask(actor, t, policy, shared)).map((t) => this.presentTask(t));
  }

  async getTask(actor: Actor, id: string) {
    const t = await this.requireTaskView(actor, id);
    const [runs, artifacts, assignments] = await Promise.all([
      this.db.query(
        "SELECT id, agent_id, attempt, runtime_generation, status, started_at, finished_at, summary, usage FROM task_runs WHERE task_id=$1 ORDER BY started_at",
        [id],
      ),
      this.db.query("SELECT id, name, content_type, sha256, length(content) AS size, created_at, run_id FROM artifacts WHERE task_id=$1 ORDER BY created_at", [id]),
      this.db.query("SELECT from_agent_id, to_agent_id, by_actor, at FROM task_assignments WHERE task_id=$1 ORDER BY id", [id]),
    ]);
    return {
      ...this.presentTask(t),
      runs: runs.rows,
      artifacts: artifacts.rows.map((a) => ({ ...a, size: Number(a.size) })),
      assignments: assignments.rows,
    };
  }

  private async setTaskStatus(ctx: Ctx, t: TaskRow, to: TaskStatus, reason: string | null, summary?: string | null) {
    if (t.status !== to && !canTransition(t.status, to)) throw conflict("bad_transition", `task cannot go from ${t.status} to ${to}`);
    await ctx.c.query("UPDATE tasks SET status=$2, status_reason=$3, summary=COALESCE($4, summary), updated_at=now() WHERE id=$1", [
      t.id,
      to,
      reason,
      summary ?? null,
    ]);
    await this.emit(ctx, { type: "task.status", agentId: t.assignee_agent_id, taskId: t.id, payload: { from: t.status, to, reason, title: t.title } });
    t.status = to;
  }

  /** Who may manage (cancel/retry) a task: its creator, or whoever can assign work to its assignee. */
  private async requireTaskManage(actor: Actor, t: TaskRow, q: Queryable, what: string) {
    if (actor.kind === "human" || t.created_by === actorRef(actor)) {
      await this.audit(q, actor, what, t.id, true, "owner or task creator");
      return;
    }
    await this.require(actor, "task.assign", { agentId: t.assignee_agent_id ?? undefined, projectId: t.project_id }, { q, auditAs: what });
  }

  async assignTask(actor: Actor, id: string, assigneeAgentId: string) {
    await this.withTx(async (ctx) => {
      const t = await this.getTaskRow(id, ctx.c, true);
      if (isTerminal(t.status)) throw conflict("terminal", `task is ${t.status}`);
      const policy = await this.loadPolicy(ctx.c);
      const a = await this.getAgentRow(assigneeAgentId, ctx.c);
      if (a.lifecycle_state === "retired") throw conflict("retired", "assignee is retired");
      // Need authority over both the current and the new owner.
      if (t.assignee_agent_id && actor.kind === "agent" && t.created_by !== actorRef(actor)) {
        await this.require(actor, "task.assign", { agentId: t.assignee_agent_id, projectId: t.project_id }, { policy, q: ctx.c, auditAs: "task.assign.from" });
      }
      await this.require(actor, "task.assign", { agentId: assigneeAgentId, projectId: t.project_id }, { policy, q: ctx.c });
      if (t.spec.kind === "script") await this.require(actor, "runtime.exec", { agentId: assigneeAgentId }, { policy, q: ctx.c, auditAs: "task.assign.script" });
      await ctx.c.query("UPDATE task_runs SET status='cancelled', finished_at=now(), summary='reassigned' WHERE task_id=$1 AND status='running'", [id]);
      await ctx.c.query("INSERT INTO task_assignments(task_id, from_agent_id, to_agent_id, by_actor) VALUES ($1,$2,$3,$4)", [
        id,
        t.assignee_agent_id,
        assigneeAgentId,
        actorRef(actor),
      ]);
      const from = t.assignee_agent_id;
      await ctx.c.query("UPDATE tasks SET assignee_agent_id=$2 WHERE id=$1", [id, assigneeAgentId]);
      t.assignee_agent_id = assigneeAgentId;
      await this.setTaskStatus(ctx, t, "assigned", `assigned by ${actorRef(actor)}`);
      await this.emit(ctx, { type: "task.assigned", agentId: assigneeAgentId, taskId: id, payload: { from, to: assigneeAgentId } });
    });
    return this.getTask(actor, id);
  }

  async cancelTask(actor: Actor, id: string, reason: string) {
    await this.withTx(async (ctx) => {
      const t = await this.getTaskRow(id, ctx.c, true);
      if (isTerminal(t.status)) return;
      await this.requireTaskManage(actor, t, ctx.c, "task.cancel");
      await ctx.c.query("UPDATE task_runs SET status='cancelled', finished_at=now(), summary=$2 WHERE task_id=$1 AND status='running'", [id, reason]);
      await this.setTaskStatus(ctx, t, "cancelled", reason || `cancelled by ${actorRef(actor)}`);
    });
    return this.getTask(actor, id);
  }

  async retryTask(actor: Actor, id: string) {
    await this.withTx(async (ctx) => {
      const t = await this.getTaskRow(id, ctx.c, true);
      if (!["failed", "blocked"].includes(t.status)) throw conflict("bad_state", `only failed or blocked tasks can be retried (is ${t.status})`);
      await this.requireTaskManage(actor, t, ctx.c, "task.retry");
      await ctx.c.query("UPDATE tasks SET attempt = attempt + 1, max_attempts = GREATEST(max_attempts, attempt + 1) WHERE id=$1", [id]);
      await this.setTaskStatus(ctx, t, "assigned", `retry requested by ${actorRef(actor)}`);
    });
    return this.getTask(actor, id);
  }

  async reviewTask(actor: Actor, id: string, decision: "approve" | "reject", note: string) {
    await this.withTx(async (ctx) => {
      const t = await this.getTaskRow(id, ctx.c, true);
      if (t.status !== "review") throw conflict("bad_state", `task is ${t.status}, not in review`);
      if (actor.kind === "agent" && t.assignee_agent_id === actor.id) throw deny("cannot review your own work");
      if (actor.kind === "human" || t.created_by === actorRef(actor)) {
        await this.audit(ctx.c, actor, "task.review", id, true, "owner or task creator", { decision });
      } else {
        await this.require(actor, "task.review", { agentId: t.assignee_agent_id ?? undefined, projectId: t.project_id }, { q: ctx.c, detail: { decision } });
      }
      if (decision === "approve") await this.setTaskStatus(ctx, t, "done", note || `approved by ${actorRef(actor)}`);
      else {
        await ctx.c.query("UPDATE tasks SET attempt = attempt + 1, max_attempts = GREATEST(max_attempts, attempt + 1) WHERE id=$1", [id]);
        await this.setTaskStatus(ctx, t, "assigned", `changes requested: ${note}`);
      }
    });
    return this.getTask(actor, id);
  }

  // ---------------------------------------------------------------- harness-facing

  private requireAgent(actor: Actor): string {
    if (actor.kind !== "agent") throw deny("runtime endpoints are for agent runtimes");
    return actor.id;
  }

  /** Reject calls from a runtime generation that has been replaced. */
  private async requireCurrentGeneration(agentId: string, generation: number, q: Queryable) {
    const rt = await this.getRuntimeRow(agentId, q);
    if (rt.generation !== generation) {
      throw conflict("stale_runtime", `runtime generation ${generation} was replaced by ${rt.generation}`);
    }
    return rt;
  }

  async heartbeat(actor: Actor, input: { generation: number; state: WorkState; detail?: string }) {
    const agentId = this.requireAgent(actor);
    if (!WORK_STATES.includes(input.state)) throw badRequest("invalid state");
    return this.withTx(async (ctx) => {
      await this.requireCurrentGeneration(agentId, input.generation, ctx.c);
      const prev = await this.getAgentRow(agentId, ctx.c);
      const detail = input.detail ? redactLine(input.detail).slice(0, 300) : null;
      await ctx.c.query(
        "UPDATE agents SET last_heartbeat_at=now(), work_state=$2, work_detail=$3, work_updated_at = CASE WHEN work_state <> $2 OR work_detail IS DISTINCT FROM $3 THEN now() ELSE work_updated_at END WHERE id=$1",
        [agentId, input.state, detail],
      );
      if (prev.work_state !== input.state || prev.work_detail !== detail || !prev.last_heartbeat_at) {
        await this.emit(ctx, { type: "work.state", agentId, payload: { state: input.state, detail } });
      }
      return { acceptingWork: prev.accepting_work && prev.lifecycle_state !== "retired" };
    });
  }

  /**
   * Lease the next task. Returns the agent's already-running run for this
   * generation first (harness restarted its loop), so a retry never starts a
   * second worker for the same attempt.
   */
  async claim(actor: Actor, generation: number) {
    const agentId = this.requireAgent(actor);
    return this.withTx(async (ctx) => {
      await this.requireCurrentGeneration(agentId, generation, ctx.c);
      const agent = await this.getAgentRow(agentId, ctx.c);
      const existing = await ctx.c.query(
        "SELECT * FROM task_runs WHERE agent_id=$1 AND status='running' AND runtime_generation=$2 LIMIT 1",
        [agentId, generation],
      );
      if (existing.rows[0]) {
        const run = existing.rows[0];
        return { run: this.presentRun(run), task: this.presentTask(await this.getTaskRow(run.task_id, ctx.c)), resumed: true };
      }
      if (!agent.accepting_work || agent.lifecycle_state === "retired") return null;
      const { rows } = await ctx.c.query<TaskRow>(
        `SELECT * FROM tasks WHERE assignee_agent_id=$1 AND status='assigned' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [agentId],
      );
      const t = rows[0];
      if (!t) return null;
      const runId = newId("r");
      const ins = await ctx.c.query(
        `INSERT INTO task_runs(id, task_id, agent_id, attempt, idempotency_key, runtime_generation, lease_expires_at, status)
         VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7), 'running')
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
        [runId, t.id, agentId, t.attempt, `${t.id}:${t.attempt}`, generation, LEASE_SECONDS],
      );
      if (!ins.rows[0]) {
        // This attempt already had a run (e.g. it finished but the status update raced). Never start it twice.
        await ctx.c.query("UPDATE tasks SET attempt = attempt + 1 WHERE id=$1", [t.id]);
        return null;
      }
      await this.setTaskStatus(ctx, t, "in_progress", null);
      await this.emit(ctx, { type: "run.started", agentId, taskId: t.id, runId, payload: { attempt: t.attempt, generation, title: t.title } });
      return { run: this.presentRun(ins.rows[0]), task: this.presentTask(t), resumed: false };
    });
  }

  presentRun(r: Record<string, any>) {
    return {
      id: r.id,
      taskId: r.task_id,
      agentId: r.agent_id,
      attempt: r.attempt,
      idempotencyKey: r.idempotency_key,
      runtimeGeneration: r.runtime_generation,
      leaseExpiresAt: r.lease_expires_at,
      status: r.status,
    };
  }

  private async requireOwnRun(agentId: string, runId: string, generation: number, q: Queryable, lock = false) {
    const { rows } = await q.query(`SELECT * FROM task_runs WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`, [runId]);
    const run = rows[0];
    if (!run || run.agent_id !== agentId) throw notFound("run");
    if (run.runtime_generation !== generation) throw conflict("stale_runtime", "run belongs to a replaced runtime generation");
    if (run.status !== "running") throw conflict("run_closed", `run is ${run.status}`);
    return run;
  }

  async runHeartbeat(actor: Actor, runId: string, generation: number) {
    const agentId = this.requireAgent(actor);
    const { rows } = await this.db.query(
      `UPDATE task_runs SET lease_expires_at = now() + make_interval(secs => $4)
       WHERE id=$1 AND agent_id=$2 AND runtime_generation=$3 AND status='running' RETURNING lease_expires_at`,
      [runId, agentId, generation, LEASE_SECONDS],
    );
    if (!rows[0]) throw conflict("run_closed", "run is not running for this runtime");
    return { leaseExpiresAt: rows[0].lease_expires_at };
  }

  async runLogs(actor: Actor, runId: string, generation: number, lines: Array<{ stream: string; line: string }>) {
    const agentId = this.requireAgent(actor);
    await this.requireOwnRun(agentId, runId, generation, this.db);
    const batch = lines.slice(0, 500);
    if (!batch.length) return;
    const values: unknown[] = [];
    const tuples = batch.map((l) => {
      values.push(agentId, runId, l.stream === "stderr" ? "stderr" : l.stream === "agent" ? "agent" : "stdout", redactLine(String(l.line)).slice(0, 4000));
      const n = values.length;
      return `($${n - 3},$${n - 2},$${n - 1},$${n})`;
    });
    await this.db.query(`INSERT INTO agent_logs(agent_id, run_id, stream, line) VALUES ${tuples.join(",")}`, values);
  }

  async uploadArtifact(actor: Actor, runId: string, generation: number, input: { name: string; contentType: string; content: Buffer }) {
    const agentId = this.requireAgent(actor);
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(input.name)) throw badRequest("invalid artifact name");
    if (input.content.length > 2 * 1024 * 1024) throw badRequest("artifact too large (2 MiB max)");
    return this.withTx(async (ctx) => {
      const run = await this.requireOwnRun(agentId, runId, generation, ctx.c);
      const id = newId("f");
      const hash = sha256(input.content);
      const { rows } = await ctx.c.query(
        `INSERT INTO artifacts(id, task_id, run_id, agent_id, name, content_type, content, sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (run_id, name) DO UPDATE SET content=EXCLUDED.content, sha256=EXCLUDED.sha256, content_type=EXCLUDED.content_type
         RETURNING id`,
        [id, run.task_id, runId, agentId, input.name, input.contentType.slice(0, 100), input.content, hash],
      );
      await this.emit(ctx, { type: "artifact.created", agentId, taskId: run.task_id, runId, payload: { name: input.name, sha256: hash, size: input.content.length } });
      return { id: rows[0].id, sha256: hash };
    });
  }

  async getArtifact(actor: Actor, id: string) {
    const { rows } = await this.db.query("SELECT * FROM artifacts WHERE id=$1", [id]);
    const a = rows[0];
    if (!a) throw notFound("artifact");
    await this.requireTaskView(actor, a.task_id);
    return { name: a.name as string, contentType: a.content_type as string, content: a.content as Buffer, sha256: a.sha256 as string };
  }

  async runEvent(actor: Actor, runId: string, generation: number, input: { type: string; message?: string; data?: Record<string, unknown> }) {
    const agentId = this.requireAgent(actor);
    if (!/^[a-z][a-z0-9_.]{0,40}$/.test(input.type)) throw badRequest("invalid event type");
    await this.withTx(async (ctx) => {
      const run = await this.requireOwnRun(agentId, runId, generation, ctx.c);
      await this.emit(ctx, {
        type: `harness.${input.type}`,
        agentId,
        taskId: run.task_id,
        runId,
        payload: { message: input.message?.slice(0, 500), ...(input.data ?? {}) },
      });
    });
  }

  async completeRun(
    actor: Actor,
    runId: string,
    generation: number,
    input: { outcome: "succeeded" | "failed" | "blocked"; summary?: string; usage?: Record<string, unknown> },
  ) {
    const agentId = this.requireAgent(actor);
    return this.withTx(async (ctx) => {
      const run = await this.requireOwnRun(agentId, runId, generation, ctx.c, true);
      const summary = input.summary ? redactLine(input.summary).slice(0, 4000) : null;
      await ctx.c.query("UPDATE task_runs SET status=$2, finished_at=now(), summary=$3, usage=$4 WHERE id=$1", [
        runId,
        input.outcome,
        summary,
        input.usage ? JSON.stringify(sanitize(input.usage)) : null,
      ]);
      const t = await this.getTaskRow(run.task_id, ctx.c, true);
      if (t.status === "in_progress" && t.assignee_agent_id === agentId) {
        if (input.outcome === "succeeded") await this.setTaskStatus(ctx, t, t.requires_review ? "review" : "done", null, summary);
        else await this.setTaskStatus(ctx, t, input.outcome, summary ?? input.outcome, summary);
      }
      await this.emit(ctx, { type: "run.finished", agentId, taskId: t.id, runId, payload: { outcome: input.outcome, summary, usage: input.usage ?? null } });
      return { taskStatus: t.status };
    });
  }

  /** Expired leases: the worker is presumed gone. Mark lost and requeue (bounded). */
  async sweepLeases(): Promise<number> {
    return this.withTx(async (ctx) => {
      const { rows } = await ctx.c.query<{ id: string; task_id: string }>(
        "UPDATE task_runs SET status='lost', finished_at=now(), summary='lease expired' WHERE status='running' AND lease_expires_at < now() RETURNING id, task_id",
      );
      for (const r of rows) await this.requeueAfterLostRun(ctx, r.task_id, r.id, "lease expired");
      return rows.length;
    });
  }

  // ---------------------------------------------------------------- runtime observations (controller)

  async recordObservation(agentId: string, obs: { state: string; detail: string | null; workloadRef: string | null; generation: number; ready: boolean }) {
    await this.withTx(async (ctx) => {
      const rt = await this.getRuntimeRow(agentId, ctx.c);
      if (rt.generation !== obs.generation) return; // stale observation
      const readyGen = obs.ready ? obs.generation : rt.ready_generation === obs.generation ? null : rt.ready_generation;
      const changed = rt.observed_state !== obs.state || rt.observed_detail !== obs.detail || rt.workload_ref !== obs.workloadRef || rt.ready_generation !== readyGen;
      await ctx.c.query(
        "UPDATE agent_runtimes SET observed_state=$2, observed_detail=$3, workload_ref=$4, observed_at=now(), ready_generation=$5 WHERE agent_id=$1",
        [agentId, obs.state, obs.detail, obs.workloadRef, readyGen],
      );
      if (obs.ready) {
        const agent = await this.getAgentRow(agentId, ctx.c);
        if (agent.lifecycle_state === "provisioning") {
          await ctx.c.query("UPDATE agents SET lifecycle_state='active' WHERE id=$1", [agentId]);
          await this.emit(ctx, { type: "agent.active", agentId, payload: {} });
        }
      }
      if (changed) {
        await this.emit(ctx, {
          type: "runtime.state",
          agentId,
          payload: { state: obs.state, detail: obs.detail, generation: obs.generation, ready: obs.ready, workloadRef: obs.workloadRef },
        });
      }
    });
  }

  async controllerBumpGeneration(agentId: string, reason: string): Promise<number> {
    return this.withTx((ctx) => this.bumpGeneration(ctx, agentId, reason));
  }

  // ---------------------------------------------------------------- office snapshot & events

  async snapshot(actor: Actor) {
    const { rows } = await this.db.query<{ seq: string | null }>("SELECT max(seq) AS seq FROM agent_events");
    const cursor = Number(rows[0]?.seq ?? 0);
    const [agents, tasks, departments, projects] = await Promise.all([
      this.listAgents(actor),
      this.listTasks(actor),
      this.db.query("SELECT id, name, color FROM departments ORDER BY id"),
      this.db.query("SELECT id, name FROM projects ORDER BY id"),
    ]);
    return {
      cursor,
      organization: this.config.organization,
      me: actor,
      departments: this.config.departments.map((d) => departments.rows.find((r) => r.id === d.id) ?? d),
      projects: projects.rows,
      agents,
      tasks,
      serverTime: new Date().toISOString(),
    };
  }

  async visibleFilter(actor: Actor): Promise<(e: AgentEventRow) => boolean> {
    if (actor.kind === "human") return () => true;
    const policy = await this.loadPolicy();
    return (e) => !!e.agentId && authorize(actor, "org.view", { agentId: e.agentId }, policy).allowed;
  }

  async eventsAfter(actor: Actor, cursor: number, limit = 1000): Promise<AgentEventRow[]> {
    const { rows } = await this.db.query(
      "SELECT seq, at, agent_id, task_id, run_id, type, payload FROM agent_events WHERE seq > $1 ORDER BY seq LIMIT $2",
      [cursor, limit],
    );
    const visible = await this.visibleFilter(actor);
    return rows
      .map((r) => ({
        seq: Number(r.seq),
        at: r.at.toISOString(),
        agentId: r.agent_id,
        taskId: r.task_id,
        runId: r.run_id,
        type: r.type,
        payload: r.payload,
      }))
      .filter(visible);
  }

  async listAudit(actor: Actor, after: number) {
    if (actor.kind !== "human") throw deny("audit log is owner-only");
    const { rows } = await this.db.query("SELECT * FROM audit_events WHERE id > $1 ORDER BY id DESC LIMIT 300", [after]);
    return rows.map((r) => ({ ...r, id: Number(r.id), policy_revision: r.policy_revision === null ? null : Number(r.policy_revision) }));
  }

  catalog(actor: Actor) {
    void actor;
    return {
      templates: this.config.agentTemplates,
      presets: this.config.runtimeCatalog.map((p) => ({ id: p.id, version: p.version, harness: p.harness, image: p.image, resources: p.resources })),
      departments: this.config.departments,
      projects: this.config.projects,
    };
  }

  // ---------------------------------------------------------------- terminal sessions

  async openTerminal(actor: Actor, agentId: string) {
    return this.withTx(async (ctx) => {
      await this.getAgentRow(agentId, ctx.c);
      await this.require(actor, "runtime.exec", { agentId }, { q: ctx.c, auditAs: "terminal.open" });
      const rt = await this.getRuntimeRow(agentId, ctx.c);
      if (rt.observed_state !== "running" || rt.ready_generation !== rt.generation || !rt.workload_ref) {
        throw conflict("runtime_not_ready", "runtime is not running; start it before opening a terminal");
      }
      const id = newId("ts");
      const ticket = newSecret();
      await ctx.c.query(
        `INSERT INTO terminal_sessions(id, actor, agent_id, generation, ticket_hash, ticket_expires_at)
         VALUES ($1,$2,$3,$4,$5, now() + make_interval(secs => $6))`,
        [id, actorRef(actor), agentId, rt.generation, sha256(ticket), TICKET_TTL_MS / 1000],
      );
      await this.emit(ctx, { type: "terminal.opened", agentId, payload: { sessionId: id, actor: actorRef(actor), generation: rt.generation } });
      return { sessionId: id, ticket, generation: rt.generation };
    });
  }

  /** One-time ticket → session target. Authorization and generation are re-checked at attach time. */
  async attachTerminal(sessionId: string, ticket: string) {
    // Redeeming burns the ticket even if the re-check below fails.
    const { rows } = await this.db.query(
      "UPDATE terminal_sessions SET ticket_hash=NULL, attached_at=now() WHERE id=$1 AND ticket_hash=$2 AND ticket_expires_at > now() AND closed_at IS NULL RETURNING *",
      [sessionId, sha256(ticket)],
    );
    const s = rows[0];
    if (!s) throw deny("invalid or expired terminal ticket");
    const actor = this.parseActorRef(s.actor);
    const reason = await this.terminalStillAllowed(actor, s.agent_id, s.generation, this.db);
    if (reason) {
      await this.closeTerminal(sessionId, reason);
      throw deny(reason);
    }
    const rt = await this.getRuntimeRow(s.agent_id);
    await this.audit(this.db, actor, "terminal.attach", s.agent_id, true, "ticket redeemed", { sessionId, generation: s.generation });
    return { agentId: s.agent_id as string, namespace: rt.namespace, pod: rt.workload_ref!, generation: s.generation as number };
  }

  parseActorRef(ref: string): Actor {
    const [kind, id] = ref.split(":") as [string, string];
    return kind === "human" ? { kind: "human", id, role: "owner" } : { kind: "agent", id };
  }

  private async terminalStillAllowed(actor: Actor, agentId: string, generation: number, q: Queryable): Promise<string | null> {
    const policy = await this.loadPolicy(q);
    const d = authorize(actor, "runtime.exec", { agentId }, policy);
    if (!d.allowed) return `exec permission no longer held: ${d.reason}`;
    const rt = await this.getRuntimeRow(agentId, q);
    if (rt.generation !== generation) return "runtime was replaced";
    return null;
  }

  private async closeTerminalRow(q: Queryable, id: string, reason: string) {
    await q.query("UPDATE terminal_sessions SET closed_at=now(), close_reason=$2 WHERE id=$1 AND closed_at IS NULL", [id, reason]);
  }

  async closeTerminal(id: string, reason: string) {
    await this.withTx(async (ctx) => {
      const { rows } = await ctx.c.query("SELECT agent_id, actor FROM terminal_sessions WHERE id=$1 AND closed_at IS NULL", [id]);
      if (!rows[0]) return;
      await this.closeTerminalRow(ctx.c, id, reason);
      await this.audit(ctx.c, rows[0].actor, "terminal.close", rows[0].agent_id, true, reason, { sessionId: id });
      await this.emit(ctx, { type: "terminal.closed", agentId: rows[0].agent_id, payload: { sessionId: id, reason } });
    });
  }

  /** Sessions that must be terminated after a policy/graph/runtime change. */
  async terminalsToRevoke(): Promise<Array<{ id: string; reason: string }>> {
    const { rows } = await this.db.query("SELECT id, actor, agent_id, generation FROM terminal_sessions WHERE closed_at IS NULL AND attached_at IS NOT NULL");
    const out: Array<{ id: string; reason: string }> = [];
    for (const s of rows) {
      const reason = await this.terminalStillAllowed(this.parseActorRef(s.actor), s.agent_id, s.generation, this.db);
      if (reason) out.push({ id: s.id, reason });
    }
    return out;
  }
}

export { ApiError };
