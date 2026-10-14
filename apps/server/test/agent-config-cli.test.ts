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
      env: { ...process.env, AGENTOWN_API_URL: baseUrl, AGENTOWN_TOKEN: env.token(agentId), AGENTOWN_AGENT_ID: agentId },
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
    expect([...env.driver.pods.values()].filter((p) => ["ceo", "po", "lead-eng", "lead-ops", workerId].includes(p.agentId)).every((p) => p.providerKey === null && p.llmEnv.AGENTOWN_LLM_BROKER === "1")).toBe(true);
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
