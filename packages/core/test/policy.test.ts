import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Actor,
  type AgentNode,
  type Grant,
  OrgGraph,
  authorize,
  canDelegate,
  canGrantToUser,
  parseOrgConfig,
  scopeWithin,
} from "../src/index.ts";

const config = parseOrgConfig(readFileSync(new URL("../../../config/agentown.yaml", import.meta.url), "utf8"));

/** Fixture: config bootstrap + one engineer/QA under lead-eng and one engineer under lead-ops. */
function fixture(extra: Array<[string, string, string, string]> = []) {
  const rows: Array<[string, string, string, string | null]> = [
    ...config.bootstrap.agents.map((a) => [a.key, a.template, a.department, a.reportsTo] as [string, string, string, string | null]),
    ["eng-1", "engineer-v1", "eng", "lead-eng"],
    ["qa-1", "qa-v1", "eng", "lead-eng"],
    ["ops-1", "engineer-v1", "ops", "lead-ops"],
    ...extra,
  ];
  const agents: AgentNode[] = rows.map(([id, , dept, reportsTo]) => ({
    id,
    departmentId: dept,
    reportsToAgentId: reportsTo,
    lifecycleState: "active",
  }));
  const grants: Grant[] = [];
  let n = 0;
  for (const [id, templateId] of rows) {
    const tpl = config.agentTemplates.find((t) => t.id === templateId)!;
    for (const c of config.policyProfiles[tpl.policyProfile]!) {
      grants.push({
        id: `g${++n}`,
        principalId: id,
        action: c.action,
        scope: c.scope,
        constraints: { ...(c.templates ? { templates: c.templates } : {}), ...(c.repos ? { repos: c.repos } : {}) },
        delegable: c.delegable,
        issuer: `template:${templateId}`,
        parentGrantId: null,
        expiresAt: null,
        revokedAt: null,
        revision: 1,
      });
    }
  }
  return { graph: new OrgGraph(agents), grants, agents };
}

const agent = (id: string): Actor => ({ kind: "agent", id });

describe("authorize", () => {
  const ctx = fixture();

  it("leader can exec/control its direct reports", () => {
    expect(authorize(agent("lead-eng"), "runtime.exec", { agentId: "eng-1" }, ctx).allowed).toBe(true);
    expect(authorize(agent("lead-eng"), "runtime.control", { agentId: "qa-1" }, ctx).allowed).toBe(true);
  });

  it("leader cannot touch the CEO, the other leader, or the other leader's people", () => {
    for (const target of ["ceo", "lead-ops", "ops-1", "po"]) {
      expect(authorize(agent("lead-eng"), "runtime.exec", { agentId: target }, ctx).allowed, target).toBe(false);
      expect(authorize(agent("lead-eng"), "task.assign", { agentId: target }, ctx).allowed, target).toBe(false);
      expect(authorize(agent("lead-eng"), "runtime.control", { agentId: target }, ctx).allowed, target).toBe(false);
    }
  });

  it("leader exec scope is direct reports, not descendants", () => {
    const deep = fixture([["eng-1-intern", "engineer-v1", "eng", "eng-1"]]);
    expect(authorize(agent("lead-eng"), "runtime.exec", { agentId: "eng-1-intern" }, deep).allowed).toBe(false);
    // ...whereas task.assign is team-scoped in the config.
    expect(authorize(agent("lead-eng"), "task.assign", { agentId: "eng-1-intern" }, deep).allowed).toBe(true);
  });

  it("CEO title gives no exec by default", () => {
    const d = authorize(agent("ceo"), "runtime.exec", { agentId: "eng-1" }, ctx);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/no grant for runtime.exec/);
  });

  it("PO has no terminal and no spawn, but can create website tasks", () => {
    expect(authorize(agent("po"), "runtime.exec", { agentId: "eng-1" }, ctx).allowed).toBe(false);
    expect(authorize(agent("po"), "agent.spawn", { agentId: "po", templateId: "engineer-v1" }, ctx).allowed).toBe(false);
    expect(authorize(agent("po"), "task.create", { agentId: "eng-1", projectId: "website" }, ctx).allowed).toBe(true);
    expect(authorize(agent("po"), "task.create", { agentId: "eng-1", projectId: null }, ctx).allowed).toBe(false);
  });

  it("workers cannot spawn, delegate, or reach others", () => {
    expect(authorize(agent("eng-1"), "agent.spawn", { agentId: "eng-1", templateId: "engineer-v1" }, ctx).allowed).toBe(false);
    expect(authorize(agent("eng-1"), "permission.delegate", { agentId: "qa-1" }, ctx).allowed).toBe(false);
    expect(authorize(agent("eng-1"), "runtime.logs", { agentId: "qa-1" }, ctx).allowed).toBe(false);
    expect(authorize(agent("eng-1"), "runtime.logs", { agentId: "eng-1" }, ctx).allowed).toBe(true);
  });

  it("spawn is limited to listed templates and to the allowed manager", () => {
    expect(authorize(agent("lead-eng"), "agent.spawn", { agentId: "lead-eng", templateId: "engineer-v1" }, ctx).allowed).toBe(true);
    expect(authorize(agent("lead-eng"), "agent.spawn", { agentId: "lead-eng", templateId: "leader-v1" }, ctx).allowed).toBe(false);
    // leader spawn scope is `self`: cannot place a new hire under someone else
    expect(authorize(agent("lead-eng"), "agent.spawn", { agentId: "eng-1", templateId: "engineer-v1" }, ctx).allowed).toBe(false);
    expect(authorize(agent("ceo"), "agent.spawn", { agentId: "lead-eng", templateId: "engineer-v1" }, ctx).allowed).toBe(true);
    expect(authorize(agent("ceo"), "agent.spawn", { agentId: "ceo", templateId: "ceo-v1" }, ctx).allowed).toBe(false);
  });

  it("reporting changes re-scope grants immediately", () => {
    const moved = fixture();
    const before = authorize(agent("lead-eng"), "runtime.exec", { agentId: "eng-1" }, moved).allowed;
    const agents = moved.agents.map((a) => (a.id === "eng-1" ? { ...a, reportsToAgentId: "lead-ops" } : a));
    const after = authorize(agent("lead-eng"), "runtime.exec", { agentId: "eng-1" }, { ...moved, graph: new OrgGraph(agents) });
    expect(before).toBe(true);
    expect(after.allowed).toBe(false);
  });

  it("revoked, expired and retired grants are ignored", () => {
    const c = fixture();
    const exec = c.grants.find((g) => g.principalId === "lead-eng" && g.action === "runtime.exec")!;
    exec.revokedAt = new Date().toISOString();
    expect(authorize(agent("lead-eng"), "runtime.exec", { agentId: "eng-1" }, c).allowed).toBe(false);
    exec.revokedAt = null;
    exec.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(authorize(agent("lead-eng"), "runtime.exec", { agentId: "eng-1" }, c).allowed).toBe(false);

    const retired = c.agents.map((a) => (a.id === "ceo" ? { ...a, lifecycleState: "retired" as const } : a));
    expect(authorize(agent("ceo"), "org.view", { agentId: "po" }, { ...c, graph: new OrgGraph(retired) }).allowed).toBe(false);
  });

  it("unknown actors are denied", () => {
    expect(authorize(agent("ghost"), "org.view", { agentId: "ceo" }, ctx).allowed).toBe(false);
  });
});

describe("delegation", () => {
  it("CEO can delegate a narrower task.create to someone in its tree", () => {
    const ctx = fixture();
    const d = canDelegate(
      agent("ceo"),
      { principalId: "lead-eng", action: "task.create", scope: { kind: "descendants" }, constraints: {}, delegable: false },
      ctx,
    );
    expect(d.allowed).toBe(true);
    expect(d.parentGrantId).toBeTruthy();
  });

  it("CEO cannot delegate what it holds non-delegably (spawn) or does not hold (exec)", () => {
    const ctx = fixture();
    const spawn = canDelegate(
      agent("ceo"),
      { principalId: "lead-eng", action: "agent.spawn", scope: { kind: "self" }, constraints: { templates: ["engineer-v1"] }, delegable: false },
      ctx,
    );
    expect(spawn.allowed).toBe(false);
    const exec = canDelegate(
      agent("ceo"),
      { principalId: "lead-eng", action: "runtime.exec", scope: { kind: "direct-reports" }, constraints: {}, delegable: false },
      ctx,
    );
    expect(exec.allowed).toBe(false);
  });

  it("delegation cannot widen scope and cannot target self", () => {
    const ctx = fixture();
    const wide = canDelegate(
      agent("ceo"),
      { principalId: "lead-eng", action: "task.create", scope: { kind: "org" }, constraints: {}, delegable: false },
      ctx,
    );
    expect(wide.allowed).toBe(false);
    const selfGrant = canDelegate(
      agent("ceo"),
      { principalId: "ceo", action: "task.create", scope: { kind: "org" }, constraints: {}, delegable: false },
      ctx,
    );
    expect(selfGrant.allowed).toBe(false);
  });

  it("leaders cannot delegate at all", () => {
    const ctx = fixture();
    const d = canDelegate(
      agent("lead-eng"),
      { principalId: "eng-1", action: "runtime.exec", scope: { kind: "self" }, constraints: {}, delegable: false },
      ctx,
    );
    expect(d.allowed).toBe(false);
  });

  it("a delegated grant dies when its parent is revoked or the recipient leaves the tree", () => {
    const ctx = fixture();
    const d = canDelegate(
      agent("ceo"),
      { principalId: "lead-eng", action: "task.create", scope: { kind: "descendants" }, constraints: {}, delegable: false },
      ctx,
    );
    const child: Grant = {
      id: "child",
      principalId: "lead-eng",
      action: "task.create",
      scope: { kind: "descendants" },
      constraints: {},
      delegable: false,
      issuer: "ceo",
      parentGrantId: d.parentGrantId,
      expiresAt: null,
      revokedAt: null,
      revision: 1,
    };
    // Remove lead-eng's own template grant so only the delegated one could apply.
    const grants = ctx.grants.filter((g) => !(g.principalId === "lead-eng" && g.action === "task.create")).concat(child);
    const c = { ...ctx, grants };
    expect(authorize(agent("lead-eng"), "task.create", { agentId: "eng-1" }, c).allowed).toBe(true);

    const parent = grants.find((g) => g.id === d.parentGrantId)!;
    parent.revokedAt = new Date().toISOString();
    expect(authorize(agent("lead-eng"), "task.create", { agentId: "eng-1" }, c).allowed).toBe(false);
  });
});

describe("scopeWithin", () => {
  const { graph } = fixture();
  it("proves only structural containment", () => {
    expect(scopeWithin("ceo", { kind: "descendants" }, "lead-eng", { kind: "team" }, graph)).toBe(true);
    expect(scopeWithin("lead-eng", { kind: "direct-reports" }, "eng-1", { kind: "self" }, graph)).toBe(true);
    expect(scopeWithin("lead-eng", { kind: "direct-reports" }, "ops-1", { kind: "self" }, graph)).toBe(false);
    expect(scopeWithin("lead-eng", { kind: "department" }, "eng-1", { kind: "descendants" }, graph)).toBe(false);
    expect(scopeWithin("ceo", { kind: "team" }, "ceo", { kind: "org" }, graph)).toBe(false);
  });
});

describe("config", () => {
  it("rejects spawn grants without template lists", () => {
    const bad = `
organization: { id: x, name: X }
departments: [{ id: d, name: D }]
runtimeCatalog: [{ id: p, image: i, harness: script }]
policyProfiles: { boss: [{ action: agent.spawn, scope: org }] }
agentTemplates: [{ id: t, jobRole: boss, runtimePreset: p, policyProfile: boss }]
bootstrap: { agents: [] }
`;
    expect(() => parseOrgConfig(bad)).toThrow(/explicit templates/);
  });
});

describe("code grants", () => {
  it("are limited to named repositories and to the agent itself", () => {
    const ctx = fixture([["dev-1", "developer-v1", "eng", "lead-eng"]]);
    expect(authorize(agent("dev-1"), "code.propose", { agentId: "dev-1", repoId: "agentown" }, ctx).allowed).toBe(true);
    expect(authorize(agent("dev-1"), "code.propose", { agentId: "dev-1", repoId: "other" }, ctx).allowed).toBe(false);
    expect(authorize(agent("dev-1"), "code.propose", { agentId: "dev-1" }, ctx).allowed).toBe(false);
    // A plain engineer, the leader and the CEO hold no code grants at all.
    for (const who of ["eng-1", "lead-eng", "ceo"]) {
      expect(authorize(agent(who), "code.read", { agentId: who, repoId: "agentown" }, ctx).allowed, who).toBe(false);
    }
  });
});

describe("people", () => {
  const base = fixture();
  const userGrant = (id: string, principalId: string, action: Grant["action"], scope: Grant["scope"]): Grant => ({
    id,
    principalId,
    action,
    scope,
    constraints: {},
    delegable: false,
    issuer: "owner",
    parentGrantId: null,
    expiresAt: null,
    revokedAt: null,
    revision: 1,
  });
  const alice: Actor = { kind: "human", id: "alice", owner: false };
  const owner: Actor = { kind: "human", id: "owner", owner: true };
  const ctx = {
    graph: base.graph,
    grants: [
      ...base.grants,
      userGrant("u1", "user:alice", "runtime.exec", { kind: "departments", ids: ["eng"] }),
      userGrant("u2", "user:alice", "user.manage", { kind: "org" }),
      // An agent-shaped grant must never apply to a person, nor the other way round.
      userGrant("u3", "alice", "runtime.exec", { kind: "org" }),
    ],
  };

  it("only the owner holds everything implicitly", () => {
    expect(authorize(owner, "audit.view", {}, ctx).allowed).toBe(true);
    expect(authorize({ kind: "human", id: "bob", owner: false }, "org.view", { agentId: "ceo" }, ctx).allowed).toBe(false);
  });

  it("department scope covers that department only", () => {
    expect(authorize(alice, "runtime.exec", { agentId: "eng-1" }, ctx).allowed).toBe(true);
    expect(authorize(alice, "runtime.exec", { agentId: "ops-1" }, ctx).allowed).toBe(false);
    expect(authorize(agent("alice"), "runtime.exec", { agentId: "ops-1" }, ctx).allowed).toBe(false); // unknown agent
  });

  it("a user manager cannot hand out more than they hold", () => {
    const eng: Grant["scope"] = { kind: "departments", ids: ["eng"] };
    expect(canGrantToUser(alice, { action: "runtime.exec", scope: eng, constraints: {} }, ctx).allowed).toBe(true);
    expect(canGrantToUser(alice, { action: "runtime.exec", scope: { kind: "agents", ids: ["qa-1"] }, constraints: {} }, ctx).allowed).toBe(true);
    expect(canGrantToUser(alice, { action: "runtime.exec", scope: { kind: "org" }, constraints: {} }, ctx).allowed).toBe(false);
    expect(canGrantToUser(alice, { action: "runtime.exec", scope: { kind: "agents", ids: ["ops-1"] }, constraints: {} }, ctx).allowed).toBe(false);
    expect(canGrantToUser(alice, { action: "audit.view", scope: { kind: "org" }, constraints: {} }, ctx).allowed).toBe(false);
    expect(canGrantToUser(alice, { action: "user.manage", scope: { kind: "org" }, constraints: {} }, ctx).allowed).toBe(false);
    expect(canGrantToUser(owner, { action: "user.manage", scope: { kind: "org" }, constraints: {} }, ctx).allowed).toBe(true);
  });

  it("config roles may only use scopes that mean something for people", () => {
    const yaml = (perm: string) => `
organization: { id: x, name: X }
departments: [{ id: d, name: D }]
runtimeCatalog: [{ id: p, image: i, harness: script }]
policyProfiles: { w: [] }
agentTemplates: [{ id: t, jobRole: w, runtimePreset: p, policyProfile: w }]
humanRoles: { r: { name: R, permissions: [${perm}] } }
bootstrap: { agents: [] }
`;
    expect(() => parseOrgConfig(yaml("{ action: runtime.exec, scope: { departments: [d] } }"))).not.toThrow();
    expect(() => parseOrgConfig(yaml("{ action: runtime.exec, scope: team }"))).toThrow(/scope must be/);
    expect(() => parseOrgConfig(yaml("{ action: audit.view, scope: { departments: [d] } }"))).toThrow(/needs scope org/);
  });
});
