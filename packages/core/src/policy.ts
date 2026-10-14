import type { OrgGraph } from "./graph.ts";
import { principalOf, type Action, type Actor, type Decision, type Grant, type GrantConstraints, type Scope, type Target } from "./types.ts";

/**
 * Policy evaluation. Everything here is pure: the server loads the graph and the
 * grants, calls these functions, and only then performs side effects.
 *
 * Rules (handoff §5.3): default deny; scope is relative to the grant principal
 * and evaluated against the current graph; a delegated grant is only effective
 * while its parent is effective and still covers it; a job title grants nothing.
 */

export interface PolicyContext {
  graph: OrgGraph;
  grants: readonly Grant[];
  now?: Date;
}

const MAX_DELEGATION_DEPTH = 8;

export function scopeCovers(principalId: string, scope: Scope, target: Target, graph: OrgGraph): boolean {
  if (scope.kind === "projects") {
    return !!target.projectId && scope.ids.includes(target.projectId);
  }
  if (scope.kind === "org") return true;
  const agentId = target.agentId;
  if (!agentId || !graph.get(agentId)) return false;
  switch (scope.kind) {
    case "self":
      return agentId === principalId;
    case "direct-reports":
      return graph.get(agentId)!.reportsToAgentId === principalId;
    case "descendants":
      return graph.isDescendant(principalId, agentId);
    case "team":
      return agentId === principalId || graph.isDescendant(principalId, agentId);
    case "department": {
      const p = graph.get(principalId);
      return !!p && graph.get(agentId)!.departmentId === p.departmentId;
    }
    case "departments":
      return scope.ids.includes(graph.get(agentId)!.departmentId);
    case "agents":
      return scope.ids.includes(agentId);
  }
}

/**
 * Is `child` (relative to childPrincipal) provably a subset of `parent` (relative
 * to parentPrincipal) for every future shape of the graph in which childPrincipal
 * stays where it is? We only accept structural cases we can prove; anything else
 * is refused rather than guessed.
 */
export function scopeWithin(
  parentPrincipal: string,
  parent: Scope,
  childPrincipal: string,
  child: Scope,
  graph: OrgGraph,
): boolean {
  if (parent.kind === "org") return true;
  if (child.kind === "org") return false;
  if (child.kind === "projects") {
    return parent.kind === "projects" && child.ids.every((id) => parent.ids.includes(id));
  }
  if (parent.kind === "projects") return false;
  if (child.kind === "departments") {
    return parent.kind === "departments" && child.ids.every((id) => parent.ids.includes(id));
  }
  if (child.kind === "agents") {
    return child.ids.every((id) => scopeCovers(parentPrincipal, parent, { agentId: id }, graph));
  }
  if (child.kind === "self") {
    return scopeCovers(parentPrincipal, parent, { agentId: childPrincipal }, graph);
  }
  if (child.kind === "department") {
    return (
      parent.kind === "department" &&
      graph.get(parentPrincipal)?.departmentId === graph.get(childPrincipal)?.departmentId
    );
  }
  // child is direct-reports | descendants | team: everything below childPrincipal (maybe incl. itself).
  const childInTree = graph.isDescendant(parentPrincipal, childPrincipal);
  switch (parent.kind) {
    case "team":
      return childInTree || childPrincipal === parentPrincipal;
    case "descendants":
      return child.kind === "team" ? childInTree : childInTree || childPrincipal === parentPrincipal;
    case "direct-reports":
      return child.kind === "direct-reports" && childPrincipal === parentPrincipal;
    default:
      return false;
  }
}

export function constraintsWithin(parent: GrantConstraints, child: GrantConstraints): boolean {
  for (const key of ["templates", "repos"] as const) {
    const p = parent[key];
    if (!p) continue;
    const c = child[key];
    if (!c || !c.every((x) => p.includes(x))) return false;
  }
  return true;
}

export function isGrantEffective(grant: Grant, ctx: PolicyContext, depth = 0): boolean {
  const now = ctx.now ?? new Date();
  if (grant.revokedAt) return false;
  if (grant.expiresAt && new Date(grant.expiresAt) <= now) return false;
  const principal = ctx.graph.get(grant.principalId);
  if (principal && principal.lifecycleState === "retired") return false;
  if (!grant.parentGrantId) return true;
  if (depth >= MAX_DELEGATION_DEPTH) return false;
  const parent = ctx.grants.find((g) => g.id === grant.parentGrantId);
  if (!parent) return false;
  return (
    parent.action === grant.action &&
    parent.delegable &&
    isGrantEffective(parent, ctx, depth + 1) &&
    scopeWithin(parent.principalId, parent.scope, grant.principalId, grant.scope, ctx.graph) &&
    constraintsWithin(parent.constraints, grant.constraints)
  );
}

function grantMatches(grant: Grant, action: Action, target: Target, ctx: PolicyContext): boolean {
  if (grant.action !== action) return false;
  if (!scopeCovers(grant.principalId, grant.scope, target, ctx.graph)) return false;
  if (action === "agent.spawn") {
    // Spawn grants must name their templates explicitly; no template list = no spawn.
    if (!target.templateId || !grant.constraints.templates?.includes(target.templateId)) return false;
  }
  if (action.startsWith("code.")) {
    // Code grants must name their repositories explicitly.
    if (!target.repoId || !grant.constraints.repos?.includes(target.repoId)) return false;
  }
  return isGrantEffective(grant, ctx);
}

export function authorize(actor: Actor, action: Action, target: Target, ctx: PolicyContext): Decision {
  if (actor.kind === "human") {
    if (actor.owner) return { allowed: true, reason: "organization owner" };
  } else {
    const self = ctx.graph.get(actor.id);
    if (!self) return { allowed: false, reason: "unknown actor" };
    if (self.lifecycleState === "retired") return { allowed: false, reason: "actor is retired" };
  }
  const principal = principalOf(actor);
  const candidates = ctx.grants.filter((g) => g.principalId === principal && g.action === action);
  if (candidates.length === 0) {
    return { allowed: false, reason: `no grant for ${action}` };
  }
  const hit = candidates.find((g) => grantMatches(g, action, target, ctx));
  if (hit) return { allowed: true, reason: `grant ${hit.id}`, grantId: hit.id };
  if (action === "agent.spawn" && target.templateId) {
    return { allowed: false, reason: `no ${action} grant covers template ${target.templateId} under this manager` };
  }
  return { allowed: false, reason: `grants for ${action} do not cover this target` };
}

export interface ProposedGrant {
  principalId: string;
  action: Action;
  scope: Scope;
  constraints: GrantConstraints;
  delegable: boolean;
}

export interface DelegationDecision extends Decision {
  parentGrantId: string | null;
}

/**
 * permission.delegate: the actor needs (a) permission.delegate over the recipient
 * and (b) a delegable grant of the same action that provably contains the new one.
 * Holding agent.spawn never implies being able to hand out arbitrary grants.
 */
export function canDelegate(actor: Actor, proposed: ProposedGrant, ctx: PolicyContext): DelegationDecision {
  if (actor.kind === "human" && actor.owner) return { allowed: true, reason: "organization owner", parentGrantId: null };
  const me = principalOf(actor);
  if (proposed.principalId === me) {
    return { allowed: false, reason: "cannot grant permissions to yourself", parentGrantId: null };
  }
  const gate = authorize(actor, "permission.delegate", { agentId: proposed.principalId }, ctx);
  if (!gate.allowed) return { ...gate, parentGrantId: null };

  const parents = ctx.grants.filter(
    (g) => g.principalId === me && g.action === proposed.action && g.delegable && isGrantEffective(g, ctx),
  );
  if (parents.length === 0) {
    return { allowed: false, reason: `you hold no delegable ${proposed.action} grant`, parentGrantId: null };
  }
  const parent = parents.find(
    (g) =>
      scopeWithin(me, g.scope, proposed.principalId, proposed.scope, ctx.graph) &&
      constraintsWithin(g.constraints, proposed.constraints),
  );
  if (!parent) {
    return {
      allowed: false,
      reason: `requested ${proposed.action} scope/constraints exceed what you can delegate`,
      parentGrantId: null,
    };
  }
  return { allowed: true, reason: `delegated from ${parent.id}`, parentGrantId: parent.id };
}

/**
 * user.manage: may `actor` give a person this permission? The owner may give
 * anything. Anyone else needs user.manage and must already hold an effective
 * grant of the same action that contains the new one (no handing out more than
 * you have), and user.manage itself is the owner's to give.
 */
export function canGrantToUser(actor: Actor, proposed: Omit<ProposedGrant, "principalId" | "delegable">, ctx: PolicyContext): Decision {
  if (actor.kind === "human" && actor.owner) return { allowed: true, reason: "organization owner" };
  const gate = authorize(actor, "user.manage", {}, ctx);
  if (!gate.allowed) return gate;
  if (proposed.action === "user.manage") return { allowed: false, reason: "only the owner can give user.manage" };
  const me = principalOf(actor);
  const covered = ctx.grants.some(
    (g) =>
      g.principalId === me &&
      g.action === proposed.action &&
      isGrantEffective(g, ctx) &&
      scopeWithin(me, g.scope, me, proposed.scope, ctx.graph) &&
      constraintsWithin(g.constraints, proposed.constraints),
  );
  return covered
    ? { allowed: true, reason: "within your own permissions" }
    : { allowed: false, reason: `you cannot give ${proposed.action} beyond your own scope` };
}

export function describeScope(scope: Scope): string {
  switch (scope.kind) {
    case "departments":
      return `departments(${scope.ids.join(",")})`;
    case "agents":
      return `agents(${scope.ids.join(",")})`;
    case "projects":
      return `projects(${scope.ids.join(",")})`;
    default:
      return scope.kind;
  }
}
