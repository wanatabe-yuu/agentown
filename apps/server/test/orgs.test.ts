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
    const t = env.token("lead-eng");
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
