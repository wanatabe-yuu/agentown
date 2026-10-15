import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, migrate } from "../src/db.ts";
import { setup } from "./helpers.ts";

type Env = Awaited<ReturnType<typeof setup>>;
let env: Env;

describe("upgrading a single-organization install", () => {
  it("moves every row into the existing organization and makes the old owner its admin", async () => {
    const db = createPool(process.env.DATABASE_URL_TEST ?? "postgres://agentown:agentown@127.0.0.1:5432/agentown_test");
    try {
      await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await migrate(db, 5);
      await db.query(`
        INSERT INTO organizations(id, name) VALUES ('acme', 'Acme');
        INSERT INTO departments(id, name, color) VALUES ('eng', 'Engineering', '#00f');
        INSERT INTO agents(id, department_id, display_name, job_role, template_id, lifecycle_state, desired_runtime, created_by, seat, spawn_key)
          VALUES ('ceo', 'eng', 'Ava', 'ceo', 'ceo-v1', 'active', 'running', 'owner:config', 0, 'k1');
        INSERT INTO grants(id, principal_id, action, scope, issuer) VALUES ('g1', 'ceo', 'org.view', '{"kind":"org"}', 'template:ceo-v1');
        INSERT INTO tasks(id, title, status, created_by, idempotency_key) VALUES ('t1', 'x', 'queued', 'human:owner', 'k1');
        INSERT INTO users(id, display_name, role_id, disabled_at, created_by) VALUES ('u1', 'Bo', 'viewer', now(), 'human:owner');
      `);
      await migrate(db);
      const one = async (sql: string) => (await db.query(sql)).rows[0];
      expect(await one("SELECT org_id FROM agents WHERE id='ceo'")).toEqual({ org_id: "acme" });
      expect(await one("SELECT org_id FROM grants WHERE id='g1'")).toEqual({ org_id: "acme" });
      expect(await one("SELECT org_id FROM tasks WHERE id='t1'")).toEqual({ org_id: "acme" });
      expect(await one("SELECT is_admin FROM users WHERE id='owner'")).toEqual({ is_admin: true });
      expect(await one("SELECT is_owner FROM org_members WHERE org_id='acme' AND user_id='owner'")).toEqual({ is_owner: true });
      const bo = await one("SELECT role_id, disabled_at IS NOT NULL AS disabled FROM org_members WHERE user_id='u1'");
      expect(bo).toEqual({ role_id: "viewer", disabled: true });
      expect(await one("SELECT disabled_at FROM users WHERE id='u1'")).toEqual({ disabled_at: null });
      expect(await one("SELECT to_regclass('public.departments') AS t")).toEqual({ t: null });
    } finally {
      await db.end();
    }
  });
});

describe("organization routing", () => {
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env?.close();
  });

  it("agent runtimes keep calling /api/… and stay in their own organization", async () => {
    const t = await env.member("lead-eng");
    const plain = await env.app.inject({ method: "GET", url: "/api/agents", headers: { authorization: `Bearer ${t}` } });
    expect(plain.statusCode).toBe(200);
    const other = await env.app.inject({ method: "GET", url: "/api/orgs/elsewhere/agents", headers: { authorization: `Bearer ${t}` } });
    expect(other.statusCode).toBe(404);
  });

  it("people must name the organization; non-members get not found", async () => {
    const plain = await env.app.inject({ method: "GET", url: "/api/agents", headers: { authorization: `Bearer ${env.owner}` } });
    expect(plain.statusCode).toBe(400);
    const me = await env.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${env.owner}` } });
    expect(me.json()).toMatchObject({ user: { id: "owner", admin: true }, orgs: [{ id: "agentown", owner: true }] });
    const ghost = await env.app.inject({ method: "GET", url: "/api/orgs/nope/agents", headers: { authorization: `Bearer ${env.owner}` } });
    expect(ghost.statusCode).toBe(404);
  });
});

describe("organizations made by the instance admin", () => {
  let factoryToken: string;
  const F = "/api/orgs/factory";
  const call = (token: string, method: string, url: string, body?: unknown) => env.call(token, method, url, body);

  beforeAll(async () => {
    env = await setup();
    const r = await call(env.owner, "POST", "/api/admin/orgs", { id: "factory", name: "Factory", templateId: "factory", owner: { displayName: "Fay" } });
    expect(r.status).toBe(201);
    factoryToken = r.body.ownerToken;
    await env.settle();
  });
  afterAll(async () => {
    await env?.close();
  });

  it("only the instance admin manages organizations", async () => {
    const viewer = await call(env.owner, "POST", "/api/users", { displayName: "Vic", roleId: "viewer" });
    for (const t of [viewer.body.token, factoryToken, env.token("ceo")]) {
      expect((await call(t, "GET", "/api/admin/orgs")).status).toBe(403);
      expect((await call(t, "POST", "/api/admin/orgs", { id: "x", name: "X", templateId: "lab", owner: { displayName: "X" } })).status).toBe(403);
    }
    expect((await call(env.owner, "GET", "/api/templates")).body.templates.map((t: { id: string }) => t.id).sort()).toEqual(["coffee-store", "company", "factory", "hospital", "lab"]);
  });

  it("a template org gets its own namespace and fresh agent ids", async () => {
    const { rows } = await env.db.query("SELECT a.id, r.namespace FROM agents a JOIN agent_runtimes r ON r.agent_id = a.id WHERE a.org_id='factory'");
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.namespace).toBe("agentown-o-factory");
      expect(r.id).toMatch(/^a-/);
    }
    const snap = await call(factoryToken, "GET", `${F}/office/snapshot`);
    expect(snap.body.organization).toEqual({ id: "factory", name: "Factory" });
    expect(snap.body.departments.map((d: { id: string }) => d.id)).toContain("production");
    expect(snap.body.agents.every((a: { id: string }) => rows.some((r) => r.id === a.id))).toBe(true);
    // The owner of the first org is not a member of this one.
    expect((await call(env.owner, "GET", `${F}/agents`)).status).toBe(404);
  });

  it("ids from another organization are not found, whatever the route", async () => {
    const cred = await call(env.owner, "POST", "/api/credentials", { name: "k", apiKey: "sk-test-iso-1" });
    const task = await call(env.owner, "POST", "/api/tasks", { title: "secret", assigneeAgentId: "lead-ops" });
    const grant = await call(env.owner, "POST", "/api/grants", { principalId: "lead-ops", action: "org.view", scope: { kind: "org" } });
    await env.db.query(
      `INSERT INTO task_runs(id, task_id, agent_id, attempt, idempotency_key, runtime_generation, lease_expires_at, status) VALUES ('r-iso', $1, 'lead-ops', 1, 'iso', 1, now(), 'succeeded');
       INSERT INTO artifacts(id, task_id, run_id, agent_id, name, content_type, content, sha256) VALUES ('f-iso', $1, 'r-iso', 'lead-ops', 'x.txt', 'text/plain', 'hi', 'x')`.replace(/\$1/g, `'${task.body.task.id}'`),
    );
    const t = factoryToken;
    const notFound: Array<[string, string, unknown?]> = [
      ["GET", "/agents/lead-eng"],
      ["POST", "/agents/lead-eng/pause"],
      ["PUT", "/agents/lead-eng/config", { maxTurns: 3 }],
      ["GET", "/agents/lead-eng/logs"],
      ["POST", "/agents/lead-eng/terminal-sessions"],
      ["GET", `/tasks/${task.body.task.id}`],
      ["POST", `/tasks/${task.body.task.id}/cancel`, {}],
      ["GET", "/artifacts/f-iso"],
      ["POST", `/credentials/${cred.body.id}/refresh-models`],
      ["DELETE", `/credentials/${cred.body.id}`],
      ["DELETE", `/grants/${grant.body.id}`],
      ["PATCH", "/users/owner", { disabled: true }],
      ["POST", "/agents", { templateId: "operator-v1", displayName: "x", reportsToAgentId: "lead-eng" }],
      ["POST", "/tasks", { title: "x", assigneeAgentId: "lead-eng" }],
      ["POST", "/grants", { principalId: "lead-eng", action: "org.view", scope: { kind: "org" } }],
    ];
    for (const [method, path, body] of notFound) {
      expect((await call(t, method, `${F}${path}`, body)).status, `${method} ${path}`).toBe(404);
    }
    // References inside a body are checked too.
    const mine = (await call(t, "GET", `${F}/agents`)).body.agents[0].id;
    expect((await call(t, "POST", `${F}/tasks`, { title: "x", assigneeAgentId: mine, parentTaskId: task.body.task.id })).status).toBe(404);
    expect((await call(t, "PUT", `${F}/agents/${mine}/config`, { credentialId: cred.body.id })).status).toBe(404);
    // And the first org's data is untouched.
    expect((await call(env.owner, "GET", `/api/tasks/${task.body.task.id}`)).body.status).toBe("assigned");
  });

  it("streams and listings never mix organizations", async () => {
    const factory = await env.instance.org("factory");
    const events = await factory.eventsAfter({ kind: "human", id: "x", owner: true }, 0);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.orgId === "factory")).toBe(true);
    const tasks = (await call(factoryToken, "GET", `${F}/tasks`)).body.tasks;
    expect(tasks.some((x: { title: string }) => x.title === "secret")).toBe(false);
    expect((await call(factoryToken, "GET", `${F}/credentials`)).body.credentials).toEqual([]);
  });

  it("idempotency keys are per organization", async () => {
    const mine = (await call(factoryToken, "GET", `${F}/agents`)).body.agents[0].id;
    const a = await call(factoryToken, "POST", `${F}/tasks`, { title: "same key", assigneeAgentId: mine, idempotencyKey: "k-1" });
    const b = await call(env.owner, "POST", "/api/tasks", { title: "same key", assigneeAgentId: "lead-ops", idempotencyKey: "k-1" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.task.id).not.toBe(b.body.task.id);
  });

  it("one person, different permissions per organization; shared accounts are the admin's", async () => {
    const vee = await call(env.owner, "POST", "/api/users", { displayName: "Vee", roleId: "viewer" });
    expect((await call(vee.body.token, "GET", "/api/agents")).body.agents.length).toBeGreaterThan(0);
    expect((await call(factoryToken, "POST", `${F}/users/members`, { userId: vee.body.user.id })).status).toBe(200);
    const inFactory = await env.app.inject({ method: "GET", url: `${F}/agents`, headers: { authorization: `Bearer ${vee.body.token}` } });
    expect(inFactory.json().agents).toEqual([]); // a member there, with no permissions yet
    const me = await env.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${vee.body.token}` } });
    expect(me.json().orgs.map((o: { id: string }) => o.id).sort()).toEqual(["agentown", "factory"]);
    // Factory's owner may not take over an account that also belongs to another org.
    expect((await call(factoryToken, "POST", `${F}/users/${vee.body.user.id}/token`)).status).toBe(403);
    expect((await call(factoryToken, "PATCH", `${F}/users/${vee.body.user.id}`, { displayName: "Mine" })).status).toBe(403);
    // Disabling them in Factory leaves the first org alone.
    expect((await call(factoryToken, "PATCH", `${F}/users/${vee.body.user.id}`, { disabled: true })).status).toBe(200);
    expect((await call(vee.body.token, "GET", "/api/agents")).status).toBe(200);
  });

  it("archiving stops the organization's runtimes and hides it from members", async () => {
    expect((await call(env.owner, "PATCH", "/api/admin/orgs/factory", { archived: true })).status).toBe(200);
    expect((await call(factoryToken, "GET", `${F}/agents`)).status).toBe(404);
    const { rows } = await env.db.query("SELECT DISTINCT desired_runtime FROM agents WHERE org_id='factory'");
    expect(rows).toEqual([{ desired_runtime: "stopped" }]);
    await env.settle();
    expect([...env.driver.pods.values()].some((p) => p.namespace === "agentown-o-factory")).toBe(false);
    await call(env.owner, "PATCH", "/api/admin/orgs/factory", { archived: false });
    expect((await call(factoryToken, "GET", `${F}/agents`)).status).toBe(200);
  });
});

describe("cluster manifests", () => {
  it("cover the given namespaces, skip malformed names and allow only catalog images", async () => {
    const { renderManifests } = await import("../src/runtime/manifests.ts");
    const yaml = renderManifests({
      images: ["agentown/harness:1"],
      namespaces: [
        { name: "agentown-eng", labels: {} },
        { name: "agentown-o-factory", labels: { "agentown.io/org": "factory" } },
        { name: "kube-system", labels: {} },
        { name: "agentown-Bad!", labels: {} },
      ],
      apiCidr: "10.0.0.1/32",
      apiPort: 8080,
    });
    expect(yaml).toContain("name: agentown-eng");
    expect(yaml).toContain("name: agentown-o-factory");
    expect(yaml).not.toMatch(/kind: Namespace\nmetadata:\n  name: kube-system/);
    expect(yaml).not.toContain("agentown-Bad!");
    expect(yaml).toContain("c.image in ['agentown/harness:1']");
  });
});
