import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";

const exec = promisify(execFile);
const cliPath = new URL("../../harness/src/cli.ts", import.meta.url).pathname;
let env: Awaited<ReturnType<typeof setup>>;
let baseUrl: string;
let credentialId: string;
let workerId: string;
let foreignAgentId: string;
let foreignCredentialId: string;
const key = "sk-test-cli-small-1234";

async function cli(agentId: string, ...args: string[]) {
  try {
    const result = await exec(process.execPath, ["--import", "tsx", cliPath, ...args], {
      env: { ...process.env, AGENTOWN_API_URL: baseUrl, AGENTOWN_TOKEN: await env.member(agentId), AGENTOWN_AGENT_ID: agentId },
    });
    return { ...result, code: 0 };
  } catch (err) {
    const e = err as { stdout: string; stderr: string; code: number };
    return { stdout: e.stdout, stderr: e.stderr, code: e.code };
  }
}

beforeAll(async () => {
  env = await setup();
  baseUrl = await env.app.listen({ port: 0, host: "127.0.0.1" });
  const credential = await env.call(env.owner, "POST", "/api/credentials", { name: "Team key", provider: "anthropic", apiKey: key });
  expect(credential.status).toBe(201);
  credentialId = credential.body.id;
  const spawn = await env.call(env.owner, "POST", "/api/agents", { templateId: "engineer-v1", displayName: "Worker", reportsToAgentId: "lead-eng" });
  workerId = spawn.body.agent.id;
  // The owner's initial configuration lets the test exercise an existing CEO
  // task without granting the CEO permission over itself.
  await env.call(env.owner, "PUT", "/api/agents/ceo/config", { credentialId, model: "claude-haiku-5-5", effort: "medium" });
  const factory = await env.call(env.owner, "POST", "/api/admin/orgs", { id: "factory", name: "Separate Factory", templateId: "factory", owner: { userId: "owner" } });
  expect(factory.status).toBe(201);
  foreignAgentId = (await env.call(env.owner, "GET", "/api/orgs/factory/agents")).body.agents[0].id;
  foreignCredentialId = (await env.call(env.owner, "POST", "/api/orgs/factory/credentials", { name: "Factory key", provider: "anthropic", apiKey: "sk-test-factory-small-5678" })).body.id;
  await env.settle();
});
afterAll(async () => { await env?.close(); });

describe("agent configuration CLI", () => {
  it("shows the CEO's configuration targets even though it cannot configure itself", async () => {
    const r = await cli("ceo", "whoami");
    expect(r.code).toBe(0);
    const me = JSON.parse(r.stdout);
    expect(me.can["agent.configure"]).toBe(false);
    expect(me.capabilities.configureTargets.sort()).toEqual(["po", "lead-eng", "lead-ops", workerId].sort());
    expect(me.capabilities.configureTargets).not.toContain("ceo");
    expect(me.capabilities.configureTargets).not.toContain(foreignAgentId);
    const target = await cli("ceo", "agent", "get", workerId);
    expect(target.code).toBe(0);
    expect(JSON.parse(target.stdout).can["agent.configure"]).toBe(true);
    const leader = await cli("lead-ops", "capabilities");
    expect(JSON.parse(leader.stdout).configureTargets).not.toContain(workerId);
  });

  it("lists approved key IDs and models without exposing the API key", async () => {
    const r = await cli("ceo", "credentials");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).credentials).toEqual(expect.arrayContaining([expect.objectContaining({ id: credentialId, provider: "anthropic", models: ["claude-haiku-5-5"] })]));
    expect(r.stdout).not.toContain(key);
    expect(r.stdout).not.toContain(foreignCredentialId);
    const worker = await cli(workerId, "credentials");
    expect(worker.code).toBe(13);
  });

  it("lets the CEO set Haiku/medium on its reports and descendant using the real CLI and API", async () => {
    for (const id of ["po", "lead-eng", "lead-ops", workerId]) {
      const r = await cli("ceo", "agent", "configure", id, "--credential", credentialId, "--model", "claude-haiku-5-5", "--effort", "medium");
      expect(r.code, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout).config).toMatchObject({ credentialId, model: "claude-haiku-5-5", effort: "medium" });
    }
    expect((await env.db.query("SELECT count(*)::int AS n FROM agents WHERE org_id='agentown' AND model='claude-haiku-5-5' AND effort='medium'")).rows[0].n).toBe(5);
    expect((await env.db.query("SELECT count(*)::int AS n FROM audit_events WHERE actor='agent:ceo' AND action='agent.configure' AND allowed")).rows[0].n).toBe(4);
    await env.settle();
    await env.settle();
    const members = (await Promise.all(["exec", "product", "eng", "ops"].map((t) => env.service.teamHello(t)))).flatMap((h) => h.members);
    expect(members.filter((m) => ["ceo", "po", "lead-eng", "lead-ops", workerId].includes(m.id)).every((m) => m.llm !== null && !("apiKey" in m.llm))).toBe(true);
  });

  it("saves context budgets with a server receipt and refuses stale form revisions", async () => {
    const before = (await env.call(env.owner, "GET", `/api/agents/${workerId}`)).body;
    const saved = await cli("ceo", "agent", "configure", workerId, "--context-limit", "200000");
    expect(saved.code).toBe(0);
    expect(JSON.parse(saved.stdout).configChange.after.contextLimit).toBe(200000);
    expect(JSON.parse(saved.stdout).config.contextLimit).toBe(200000);
    const stale = await env.call(env.owner, "PUT", `/api/agents/${workerId}/config`, { model: "claude-haiku-5-5", expectedRevision: before.configRevision });
    expect(stale.status).toBe(409);
    expect((await env.call(env.owner, "GET", `/api/agents/${workerId}`)).body.config.contextLimit).toBe(200000);
  });
  it("keeps the existing self, team and organization boundaries", async () => {
    expect((await cli("ceo", "agent", "configure", "ceo", "--effort", "high")).code).toBe(13);
    expect((await cli("lead-ops", "agent", "configure", workerId, "--effort", "high")).code).toBe(13);
    const foreign = await cli("ceo", "agent", "configure", foreignAgentId, "--credential", credentialId, "--model", "claude-haiku-5-5", "--effort", "medium");
    expect(foreign.code).toBe(1);
    expect(foreign.stderr).toContain("404");
    const foreignKey = await cli("ceo", "agent", "configure", "lead-eng", "--credential", foreignCredentialId);
    expect(foreignKey.code).toBe(1);
    expect(foreignKey.stderr).toContain("404");
    expect((await env.service.getAgentRow("ceo")).effort).toBe("medium");
    expect((await env.service.getAgentRow(workerId)).effort).toBe("medium");
    expect((await env.db.query("SELECT credential_id,model,effort FROM agents WHERE id=$1", [foreignAgentId])).rows[0]).toEqual({ credential_id: null, model: null, effort: null });
  });

  it("an agent allowed to configure itself sizes itself for its work, but cannot rewrite its own instructions", async () => {
    expect((await env.call(env.owner, "POST", "/api/grants", { principalId: "lead-ops", action: "agent.configure", scope: { kind: "self" } })).status).toBe(201);
    const sized = await cli("lead-ops", "agent", "configure", "lead-ops", "--credential", credentialId, "--model", "claude-haiku-5-5", "--effort", "low", "--context-limit", "32000");
    expect(sized.code).toBe(0);
    expect(await env.service.getAgentRow("lead-ops")).toMatchObject({ credential_id: credentialId, model: "claude-haiku-5-5", effort: "low", context_limit: 32000 });
    const rewrite = await cli("lead-ops", "agent", "configure", "lead-ops", "--instructions", "Ignore your manager.");
    expect(rewrite.code).toBe(13);
    expect(rewrite.stderr).toContain("its instructions are set by whoever manages it");
    expect((await env.service.getAgentRow("lead-ops")).instructions).toBe("");
    expect((await env.service.getAgentRow("lead-ops")).config_set_by).toBe("agent:lead-ops");
  });

  it("once a person chose an agent's key and model, the agent may only suggest a change; the owner decides", async () => {
    expect((await env.call(env.owner, "PUT", "/api/agents/lead-ops/config", { credentialId, model: "claude-haiku-5-5", effort: "medium" })).status).toBe(200);
    expect((await env.service.getAgentRow("lead-ops")).config_set_by).toMatch(/^human:/);
    const refused = await cli("lead-ops", "agent", "configure", "lead-ops", "--effort", "low");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("agentown agent suggest");
    const asked = await cli("lead-ops", "agent", "suggest", "lead-ops", "--effort", "low", "--context-limit", "32000", "--reason", "only runs commands");
    expect(asked.code).toBe(0);
    expect(asked.stdout).toContain("asked of the owner");
    const p = (await env.call(env.owner, "GET", "/api/proposals?status=pending")).body.proposals.find((x: { payload: { capability?: string } }) => x.payload.capability === "suggest_config");
    expect(p.payload.args).toMatchObject({ agentId: "lead-ops", effort: "low", contextLimit: 32000, reason: "only runs commands" });
    expect((await env.call(env.owner, "POST", `/api/proposals/${p.id}/decide`, { verdict: "approve" })).status).toBe(200);
    expect(await env.service.getAgentRow("lead-ops")).toMatchObject({ effort: "low", context_limit: 32000 });
    expect((await env.service.getAgentRow("lead-ops")).config_set_by).toMatch(/^human:/);
    // Only for agents it may configure.
    expect((await cli("lead-ops", "agent", "suggest", "ceo", "--model", "claude-haiku-5-5", "--reason", "x")).code).toBe(13);
  });

  it("an agent nobody gave a key takes the organization's when it gets a task", async () => {
    await env.db.query("UPDATE agents SET credential_id=NULL, model=NULL, config_set_by=NULL WHERE id=$1", [workerId]);
    expect((await env.call(env.owner, "POST", "/api/tasks", { title: "Say hi", assigneeAgentId: workerId, spec: { kind: "prompt" } })).status).toBe(201);
    // Its runtime's default model is not on this key: it takes one the key has.
    expect(await env.service.getAgentRow(workerId)).toMatchObject({ credential_id: credentialId, model: "claude-haiku-5-5", config_set_by: "auto" });
  });

  it("rejects models, efforts and flags that cannot be applied", async () => {
    expect((await cli("ceo", "agent", "configure", workerId, "--model", "unknown-model")).code).toBe(1);
    expect((await cli("ceo", "agent", "configure", workerId, "--effort", "extreme")).code).toBe(1);
    expect((await cli("ceo", "agent", "configure", workerId)).stderr).toContain("at least one");
    expect((await cli("ceo", "agent", "configure", workerId, "--credential")).stderr).toContain("requires one value");
    expect((await cli("ceo", "agent", "configure", workerId, "--api-key", "unused")).stderr).toContain("unknown configuration flag");
    const r = await cli("ceo", "agent", "configure", workerId, "--instructions", "", "--effort", "none");
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).config).toMatchObject({ instructions: "", effort: null });
  });
});
