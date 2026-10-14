import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";

type Env = Awaited<ReturnType<typeof setup>>;
let env: Env;
type Doc = Record<string, any>;
let eve = "";

beforeAll(async () => {
  env = await setup();
});
afterAll(async () => {
  await env?.close();
});

const getConfig = async () => (await env.call(env.owner, "GET", "/api/config")).body as { revision: number; doc: Doc };
const put = (revision: number, doc: Doc, token = env.owner) => env.call(token, "PUT", "/api/config", { revision, doc });
const clone = (d: Doc): Doc => structuredClone(d);

describe("editing an organization's structure", () => {
  it("is the owner's alone", async () => {
    const viewer = await env.call(env.owner, "POST", "/api/users", { displayName: "Val", roleId: "admin" });
    expect((await env.call(viewer.body.token, "GET", "/api/config")).status).toBe(403);
    const { revision, doc } = await getConfig();
    expect((await put(revision, doc, viewer.body.token)).status).toBe(403);
    expect((await put(revision, doc, env.token("ceo"))).status).toBe(403);
  });

  it("rejects stale revisions, broken documents and removing what is in use", async () => {
    const { revision, doc } = await getConfig();
    expect((await put(revision - 1, doc)).status).toBe(409);
    const noEng = clone(doc);
    noEng.departments = noEng.departments.filter((d: Doc) => d.id !== "eng");
    noEng.bootstrap.agents = noEng.bootstrap.agents.filter((a: Doc) => a.department !== "eng");
    for (const role of Object.values(noEng.humanRoles) as Doc[]) {
      role.permissions = role.permissions.filter((p: Doc) => !JSON.stringify(p.scope).includes("eng"));
    }
    const r = await put(revision, noEng);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/department eng still has agents/);
    const badPreset = clone(doc);
    badPreset.agentTemplates[0].runtimePreset = "root-shell-v9";
    expect((await put(revision, badPreset)).status).toBe(400);
    const badScope = clone(doc);
    badScope.humanRoles.viewer.permissions.push({ action: "org.view", scope: { departments: ["nowhere"] } });
    expect((await put(revision, badScope)).body.message).toMatch(/unknown department nowhere/);
  });

  it("applies at once: a new department and job can be used without a restart", async () => {
    const { revision, doc } = await getConfig();
    const next = clone(doc);
    next.departments.push({ id: "design", name: "Design", color: "#e07" });
    next.agentTemplates.push({ id: "designer-v1", jobRole: "designer", runtimePreset: "script-v1", policyProfile: "worker" });
    const r = await put(revision, next);
    expect(r.status).toBe(200);
    expect(r.body.revision).toBe(revision + 1);
    const hire = await env.call(env.owner, "POST", "/api/agents", { templateId: "designer-v1", displayName: "Dee", reportsToAgentId: "ceo", departmentId: "design" });
    expect(hire.status).toBe(202);
    const snap = await env.call(env.owner, "GET", "/api/office/snapshot");
    expect(snap.body.departments.map((d: Doc) => d.id)).toContain("design");
  });

  it("existing agents and grants survive edits to their template and profile", async () => {
    const hire = await env.call(env.owner, "POST", "/api/agents", { templateId: "engineer-v1", displayName: "Eve", reportsToAgentId: "lead-eng" });
    eve = hire.body.agent.id;
    await env.settle();
    const before = (await env.db.query("SELECT count(*)::int AS n FROM grants WHERE principal_id='lead-eng' AND revoked_at IS NULL")).rows[0].n;
    const { revision, doc } = await getConfig();
    const next = clone(doc);
    next.policyProfiles.leader = next.policyProfiles.leader.filter((c: Doc) => c.action !== "runtime.exec");
    next.agentTemplates = next.agentTemplates.filter((t: Doc) => t.id !== "engineer-v1");
    for (const caps of Object.values(next.policyProfiles) as Doc[][]) {
      for (const c of caps) if (c.templates) c.templates = c.templates.filter((t: string) => t !== "engineer-v1");
    }
    for (const role of Object.values(next.humanRoles) as Doc[]) {
      for (const c of role.permissions) if (c.templates) c.templates = c.templates.filter((t: string) => t !== "engineer-v1");
    }
    expect((await put(revision, next)).status).toBe(200);
    expect((await env.db.query("SELECT count(*)::int AS n FROM grants WHERE principal_id='lead-eng' AND revoked_at IS NULL")).rows[0].n).toBe(before);
    // Eve's job template is gone, yet her runtime keeps working.
    const { rows } = await env.db.query("SELECT generation FROM agent_runtimes WHERE agent_id=$1", [eve]);
    await env.call(env.owner, "POST", "/api/tasks", { title: "still here?", assigneeAgentId: eve, spec: { kind: "playbook", playbook: "noop", args: {} } });
    const claim = await env.call(env.token(eve), "POST", "/api/runs/claim", { generation: rows[0].generation });
    expect(claim.status).toBe(200);
    expect(claim.body.config.harness).toBe("script");
  });
});

describe("templates", () => {
  it("save, export, import and create an organization from it", async () => {
    // Eve's job template was removed above: the org cannot be a template while she uses it.
    const blocked = await env.app.inject({ method: "POST", url: "/api/orgs/agentown/templates", headers: { authorization: `Bearer ${env.owner}` }, payload: { name: "x" } });
    expect(blocked.json().message).toMatch(/no longer has/);
    expect((await env.call(env.owner, "POST", `/api/agents/${eve}/retire`, {})).status).toBe(200);
    const saved = await env.call(env.owner, "POST", "/api/templates", { name: "Our shape", description: "as of today" });
    // The org route is under /api/orgs/<id>/templates; the helper rewrites /api/templates as instance-level.
    expect(saved.status).toBe(400); // instance POST /api/templates expects { yaml }
    const s2 = await env.app.inject({ method: "POST", url: "/api/orgs/agentown/templates", headers: { authorization: `Bearer ${env.owner}` }, payload: { name: "Our shape", description: "as of today" } });
    expect(s2.statusCode).toBe(201);
    const id = s2.json().id;
    const yaml = (await env.app.inject({ method: "GET", url: `/api/templates/${id}/export`, headers: { authorization: `Bearer ${env.owner}` } })).body;
    expect(yaml).toMatch(/^format: agentown.template\/v1/m);
    expect(yaml).toMatch(/displayName: Dee/);
    expect(yaml).not.toMatch(/sk-|aho_|aag_|instructions/);
    const imported = await env.call(env.owner, "POST", "/api/templates", { yaml });
    expect(imported.status).toBe(201);
    const again = (await env.app.inject({ method: "GET", url: `/api/templates/${imported.body.id}/export`, headers: { authorization: `Bearer ${env.owner}` } })).body;
    expect(again.replace(/id: tpl-\w+/, "")).toBe(yaml.replace(/id: tpl-\w+/, ""));
    const org = await env.call(env.owner, "POST", "/api/admin/orgs", { id: "copy", name: "Copy", templateId: imported.body.id, owner: { displayName: "Cy" } });
    expect(org.status).toBe(201);
    expect(org.body.org.agents).toBe(yaml.match(/displayName:/g)!.length); // the saved tree, Dee included
  });

  it("imports are bounded and validated", async () => {
    const bomb = `format: agentown.template/v1\nmeta: { id: x, name: X }\na: &a [x,x,x,x,x,x,x,x,x,x]\n${Array.from({ length: 60 }, (_, i) => `b${i}: [*a,*a,*a,*a]`).join("\n")}\n`;
    expect((await env.call(env.owner, "POST", "/api/templates", { yaml: bomb })).status).toBe(400);
    expect((await env.call(env.owner, "POST", "/api/templates", { yaml: "format: agentown.template/v1\nmeta: { id: x, name: X }\n" })).status).toBe(400);
    expect((await env.call(env.owner, "POST", "/api/templates", { yaml: `${"#".repeat(300 * 1024)}` })).status).toBe(400);
  });

  it("saved templates are private to their author and the admin", async () => {
    const other = await env.call(env.owner, "POST", "/api/admin/orgs", { id: "other", name: "Other", templateId: "lab", owner: { displayName: "Olu" } });
    const t = other.body.ownerToken;
    const list = (await env.call(t, "GET", "/api/templates")).body.templates.map((x: Doc) => x.id);
    expect(list.sort()).toEqual(["coffee-store", "company", "factory", "hospital", "lab"]);
    const mine = (await env.call(env.owner, "GET", "/api/templates")).body.templates.find((x: Doc) => !x.builtIn);
    expect((await env.app.inject({ method: "GET", url: `/api/templates/${mine.id}/export`, headers: { authorization: `Bearer ${t}` } })).statusCode).toBe(404);
    expect((await env.call(t, "DELETE", `/api/templates/${mine.id}`)).status).toBe(404);
  });

  it("an organization whose document cannot be loaded fails alone", async () => {
    const t = (await env.call(env.owner, "POST", "/api/admin/orgs", { id: "broken", name: "Broken", templateId: "lab", owner: { displayName: "Bo" } })).body.ownerToken;
    await env.db.query(`UPDATE organizations SET config = config || '{"world":{"floors":[]}}', config_revision = config_revision + 1 WHERE id='broken'`);
    const r = await env.app.inject({ method: "GET", url: "/api/orgs/broken/agents", headers: { authorization: `Bearer ${t}` } });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe("org_config_invalid");
    await expect(env.settle()).resolves.toBeUndefined(); // the controller skips it
    expect((await env.call(env.owner, "GET", "/api/agents")).status).toBe(200);
  });
});
