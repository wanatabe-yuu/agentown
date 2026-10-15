import { type Action, type Actor, type AgentNode, type Grant, type GrantConstraints, type PolicyContext, type Scope, type Target, authorize, OrgGraph } from "@agentown/core";
import type { Queryable } from "../db.ts";
import { actorRef, deny, sanitize } from "../util.ts";

/** Permissions: the organization's grants and reporting graph, every authorization decision, and the audit trail. */

export interface LoadedPolicy extends PolicyContext {
  revision: number;
}

export interface GrantRow {
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

export function toGrant(r: GrantRow): Grant {
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

export class Permissions {
  constructor(
    private readonly db: Queryable,
    private readonly orgId: string,
  ) {}

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
      `INSERT INTO audit_events(org_id, actor, action, target, allowed, reason, policy_revision, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [this.orgId, typeof actor === "string" ? actor : actorRef(actor), action, target, allowed, reason, revision ?? null, JSON.stringify(sanitize(detail))],
    );
  }

  /** Grants and reporting lines changed: cached decisions elsewhere must be re-read. */
  async bumpRevision(q: Queryable): Promise<void> {
    await q.query("UPDATE organizations SET policy_revision = policy_revision + 1 WHERE id=$1", [this.orgId]);
  }

  async load(q: Queryable = this.db): Promise<LoadedPolicy> {
    // Sequential on purpose: q may be a single transaction client.
    const agents = await q.query<{ id: string; department_id: string; reports_to: string | null; lifecycle_state: AgentNode["lifecycleState"] }>(
      "SELECT id, department_id, reports_to, lifecycle_state FROM agents WHERE org_id=$1",
      [this.orgId],
    );
    const grants = await q.query<GrantRow>("SELECT * FROM grants WHERE org_id=$1 AND revoked_at IS NULL", [this.orgId]);
    const org = await q.query<{ policy_revision: string }>("SELECT policy_revision FROM organizations WHERE id=$1", [this.orgId]);
    return {
      graph: new OrgGraph(agents.rows.map((a) => ({ id: a.id, departmentId: a.department_id, reportsToAgentId: a.reports_to, lifecycleState: a.lifecycle_state }))),
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
    const policy = opts.policy ?? (await this.load(opts.q));
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

  /** Does the actor hold this permission anywhere: org-wide, on some agent, or for some template? */
  allowedAnywhere(actor: Actor, action: Action, policy: LoadedPolicy, where: { agentIds: string[]; templateIds?: string[] }): boolean {
    if (actor.kind === "human" && actor.owner) return true;
    const targets: Target[] = action === "agent.spawn" ? (where.templateIds ?? []).map((templateId) => ({ templateId })) : [{}];
    return targets.some((t) => authorize(actor, action, t, policy).allowed || where.agentIds.some((agentId) => authorize(actor, action, { ...t, agentId }, policy).allowed));
  }
}
