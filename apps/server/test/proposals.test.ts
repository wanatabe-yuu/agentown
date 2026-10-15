import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectResults } from "../src/selfpatch.ts";
import { setup } from "./helpers.ts";

let env: Awaited<ReturnType<typeof setup>>;
let worker: string;
beforeAll(async () => {
  env = await setup();
  const r = await env.call(env.token("lead-eng"), "POST", "/api/agents", { templateId: "engineer-v1", displayName: "Tam", reportsToAgentId: "lead-eng" });
  worker = r.body.agent.id;
  await env.settle();
});
afterAll(async () => {
  await env.close();
});

const gen = async (id: string) => (await env.service.getRuntimeRow(id)).generation;
const proposals = async (token = env.owner, q = "") => (await env.call(token, "GET", `/api/proposals${q}`)).body.proposals as any[];

async function finishTask(title: string) {
  const t = (await env.call(env.owner, "POST", "/api/tasks", { title, assigneeAgentId: worker })).body.task;
  const g = await gen(worker);
  await env.call(env.token(worker), "POST", "/api/runtime/heartbeat", { generation: g, state: "idle" });
  const c = await env.call(env.token(worker), "POST", "/api/runs/claim", { generation: g });
  await env.call(env.token(worker), "POST", `/api/runs/${c.body.run.id}/complete`, { generation: g, outcome: "succeeded", summary: `${title} done` });
  return t.id as string;
}

describe("proposal & approval engine", () => {
  it("finished work waiting for review is a proposal decided from the inbox", async () => {
    const taskId = await finishTask("Write release notes");
    const p = (await proposals(env.owner, "?status=pending")).find((x) => x.payload.taskId === taskId);
    expect(p).toMatchObject({ kind: "task_result", proposer: `agent:${worker}`, canDecide: true, approvers: { kind: "task_reviewer" } });
    // The worker cannot decide its own result; a stranger cannot see it.
    expect((await env.call(env.token(worker), "POST", `/api/proposals/${p.id}/decide`, { verdict: "approve" })).status).toBe(403);
    expect((await proposals(env.token("lead-ops"))).some((x) => x.id === p.id)).toBe(false);
    const done = await env.call(env.owner, "POST", `/api/proposals/${p.id}/decide`, { verdict: "approve", note: "ship it" });
    expect(done.status).toBe(200);
    expect(done.body.proposal).toMatchObject({ status: "applied", decisions: [{ verdict: "approve", note: "ship it" }] });
    expect((await env.call(env.owner, "GET", `/api/tasks/${taskId}`)).body.status).toBe("done");
  });

  it("rejecting sends the work back; the next attempt is a new proposal; reviewing elsewhere settles it too", async () => {
    const taskId = await finishTask("Draft FAQ");
    const first = (await proposals(env.owner, "?status=pending")).find((x) => x.payload.taskId === taskId);
    await env.call(env.owner, "POST", `/api/proposals/${first.id}/decide`, { verdict: "reject", note: "add pricing" });
    expect((await env.call(env.owner, "GET", `/api/tasks/${taskId}`)).body.status).toBe("assigned");
    const g = await gen(worker);
    const c = await env.call(env.token(worker), "POST", "/api/runs/claim", { generation: g });
    await env.call(env.token(worker), "POST", `/api/runs/${c.body.run.id}/complete`, { generation: g, outcome: "succeeded", summary: "with pricing" });
    const all = (await proposals()).filter((x) => x.payload.taskId === taskId);
    expect(all.map((x) => x.status).sort()).toEqual(["pending", "rejected"]);
    // The classic review endpoint settles the same proposal.
    await env.call(env.owner, "POST", `/api/tasks/${taskId}/review`, { decision: "approve" });
    expect((await proposals()).filter((x) => x.payload.taskId === taskId).map((x) => x.status).sort()).toEqual(["applied", "rejected"]);
  });

  it("configuration changes are recorded as applied proposals with their receipt", async () => {
    await env.call(env.token("lead-eng"), "PUT", `/api/agents/${worker}/config`, { maxTurns: 12 });
    const p = (await proposals(env.owner, "?kind=config_change"))[0];
    expect(p).toMatchObject({ status: "applied", proposer: "agent:lead-eng", subject: { type: "agent", id: worker }, receipt: { changedFields: ["maxTurns"] } });
  });
});

describe("capability system", () => {
  it("discovery offers each caller only the tools its permissions allow", async () => {
    const lead = (await env.call(env.token("lead-eng"), "GET", "/api/tools")).body.tools.map((t: any) => t.id);
    expect(lead).toEqual(expect.arrayContaining(["inspect", "create_task", "spawn_agent", "agent_action", "team_say", "bash"]));
    expect(lead).not.toContain("patch_config");
    expect(lead).not.toContain("credential_action");
    const owner = (await env.call(env.owner, "GET", "/api/tools")).body.tools;
    expect(owner.map((t: any) => t.id)).toContain("patch_config");
    expect(owner.find((t: any) => t.id === "create_task").input.properties.title).toBeTruthy();
  });

  it("the gateway validates, runs read and ordinary calls at once, and refuses what is not offered", async () => {
    const t = env.token("lead-eng");
    const read = await env.call(t, "POST", "/api/tools/inspect/invoke", { args: { kind: "agent", id: worker } });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ status: "applied", result: { id: worker } });
    expect((await env.call(t, "POST", "/api/tools/inspect/invoke", { args: { kind: "nope" } })).status).toBe(400);
    expect((await env.call(t, "POST", "/api/tools/patch_config/invoke", { args: { revision: 1, operations: [{ op: "remove", path: "/projects" }] } })).status).toBe(403);
    expect((await env.call(t, "POST", "/api/tools/bash/invoke", { args: { command: "ls" } })).status).toBe(400);
    expect((await env.call(t, "POST", "/api/tools/nope/invoke", {})).status).toBe(404);
    const said = await env.call(env.token(worker), "POST", "/api/tools/team_say/invoke", { args: { text: "Tam here" } });
    expect(said.status).toBe(200);
    const msgs = (await env.call(env.owner, "GET", "/api/teams/eng/messages")).body.messages;
    expect(msgs.some((m: any) => m.text === "Tam here" && m.author.id === worker)).toBe(true);
  });

  it("an important call by an agent becomes a pending proposal; the owner's decision runs it as the agent", async () => {
    const t = env.token("lead-eng");
    const r = await env.call(t, "POST", "/api/tools/agent_action/invoke", { args: { id: worker, action: "stop" } });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe("pending");
    expect((await env.service.getAgentRow(worker)).desired_runtime).toBe("running");
    const mine = (await proposals(t)).find((x) => x.id === r.body.proposalId);
    expect(mine).toMatchObject({ kind: "capability_call", status: "pending", canDecide: false, payload: { capability: "agent_action" } });
    expect((await env.call(t, "POST", `/api/proposals/${r.body.proposalId}/decide`, { verdict: "approve" })).status).toBe(403);
    const ok = await env.call(env.owner, "POST", `/api/proposals/${r.body.proposalId}/decide`, { verdict: "approve" });
    expect(ok.status).toBe(200);
    expect(ok.body.proposal.status).toBe("applied");
    expect((await env.service.getAgentRow(worker)).desired_runtime).toBe("stopped");
    const audit = await env.db.query("SELECT actor, allowed FROM audit_events WHERE action='runtime.stop' ORDER BY id DESC LIMIT 1");
    expect(audit.rows[0]).toMatchObject({ actor: "agent:lead-eng", allowed: true });

    const again = await env.call(t, "POST", "/api/tools/agent_action/invoke", { args: { id: worker, action: "restart" } });
    await env.call(env.owner, "POST", `/api/proposals/${again.body.proposalId}/decide`, { verdict: "reject", note: "not now" });
    expect((await proposals()).find((x) => x.id === again.body.proposalId)).toMatchObject({ status: "rejected", decisions: [{ verdict: "reject", note: "not now" }] });
  });

  it("the owner is the approver, so the owner's own calls run directly", async () => {
    const r = await env.call(env.owner, "POST", "/api/tools/agent_action/invoke", { args: { id: worker, action: "start" } });
    expect(r.status).toBe(200);
    expect((await env.service.getAgentRow(worker)).desired_runtime).toBe("running");
  });

  it("world edits: without org.design they wait and the owner applies them; designers wait or apply per the kernel setting", async () => {
    const world = (name: string) => ({ floors: [{ id: "f1", name: "Floor 1", rooms: [{ id: "eng", name, department: "eng", area: { x: 0, z: 0, w: 10, d: 8 } }] }] });
    const rev = async () => (await env.call(env.owner, "GET", "/api/world")).body.revision as number;
    const roomName = async () => (await env.call(env.owner, "GET", "/api/office/snapshot")).body.world?.floors[0].rooms[0].name;

    // No org.design: the tool is still offered, every call is a proposal, and the owner carries it out.
    const tools = (await env.call(env.token(worker), "GET", "/api/tools")).body.tools;
    expect(tools.find((t: any) => t.id === "replace_world")).toMatchObject({ approval: "always" });
    const asked = await env.call(env.token(worker), "POST", "/api/tools/replace_world/invoke", { args: { revision: await rev(), world: world("Proposed") } });
    expect(asked.status).toBe(202);
    const p = (await proposals()).find((x) => x.id === asked.body.proposalId);
    expect(p).toMatchObject({ kind: "world_change", status: "pending", payload: { runAs: "approver" } });
    const decided = await env.call(env.owner, "POST", `/api/proposals/${p.id}/decide`, { verdict: "approve" });
    expect(decided.body).toMatchObject({ proposal: { status: "applied" } });
    expect(await roomName()).toBe("Proposed");

    // A designer waits by default...
    await env.call(env.owner, "POST", "/api/grants", { principalId: "lead-eng", action: "org.design", scope: { kind: "org" } });
    const lead = env.token("lead-eng");
    const waiting = await env.call(lead, "POST", "/api/tools/replace_world/invoke", { args: { revision: await rev(), world: world("Designed") } });
    expect(waiting.status).toBe(202);
    expect((await proposals()).find((x) => x.id === waiting.body.proposalId).payload.runAs).toBeUndefined();
    await env.call(env.owner, "POST", `/api/proposals/${waiting.body.proposalId}/decide`, { verdict: "reject" });
    expect(await roomName()).toBe("Proposed");

    // ...until the owner lets designers apply directly; only the owner can change that.
    expect((await env.call(lead, "PUT", "/api/kernel", { worldEdits: "auto" })).status).toBe(403);
    expect((await env.call(env.owner, "PUT", "/api/kernel", { worldEdits: "auto" })).status).toBe(200);
    expect((await env.call(env.owner, "GET", "/api/office/snapshot")).body.kernel).toEqual({ worldEdits: "auto" });
    const direct = await env.call(lead, "POST", "/api/tools/replace_world/invoke", { args: { revision: await rev(), world: world("Designed") } });
    expect(direct.body.status).toBe("applied");
    expect(await roomName()).toBe("Designed");
    // Agents cannot route around the gate through the plain REST endpoint.
    expect((await env.call(lead, "PUT", "/api/world", { revision: await rev(), world: world("Sneaky") })).status).toBe(403);
    // Without the permission, auto changes nothing.
    expect((await env.call(env.token(worker), "POST", "/api/tools/replace_world/invoke", { args: { revision: await rev(), world: null } })).status).toBe(202);
    await env.call(env.owner, "PUT", "/api/kernel", { worldEdits: "approve" });
  });

  it("self-patching: a code proposal waits for the owner, who reads the diff; approving queues it and the build result comes back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "selfpatch-"));
    process.env.AGENTOWN_SELFPATCH_DIR = dir;
    const diff = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n";
    try {
      // Without code.propose on "self", the tool is not offered.
      expect((await env.call(env.token(worker), "POST", "/api/tools/propose_patch/invoke", { args: { title: "x", diff } })).status).toBe(403);
      const g = await env.call(env.owner, "POST", "/api/grants", { principalId: worker, action: "code.propose", scope: { kind: "self" }, constraints: { repos: ["self"] } });
      expect(g.status).toBe(201);
      const r = await env.call(env.token(worker), "POST", "/api/tools/propose_patch/invoke", { args: { title: "Fix README", summary: "one line", diff } });
      expect(r.body).toMatchObject({ status: "pending" });
      expect((await env.call(env.token(worker), "GET", `/api/code/proposals/${r.body.proposalId}/diff`)).status).toBe(403);
      const view = await env.app.inject({ method: "GET", url: `/api/orgs/${env.instance.defaultOrgId}/code/proposals/${r.body.proposalId}/diff`, headers: { authorization: `Bearer ${env.owner}` } });
      expect(view.statusCode).toBe(200);
      expect(view.body).toContain("+new");
      // The host has not set up the builder: approving fails cleanly and queues nothing.
      const off = await env.call(env.owner, "POST", `/api/proposals/${r.body.proposalId}/decide`, { verdict: "approve" });
      expect(off.status).toBe(400);
      writeFileSync(join(dir, "enabled"), "");
      const again = await env.call(env.token(worker), "POST", "/api/tools/propose_patch/invoke", { args: { title: "Fix README", diff } });
      await env.call(env.owner, "POST", `/api/proposals/${again.body.proposalId}/decide`, { verdict: "approve" });
      const queued = join(dir, "queue", `proposal-${again.body.proposalId}.patch`);
      expect(existsSync(queued) && readFileSync(queued, "utf8")).toBe(diff);
      mkdirSync(join(dir, "results"), { recursive: true });
      writeFileSync(join(dir, "results", `proposal-${again.body.proposalId}.json`), JSON.stringify({ status: "failed", log: "typecheck failed" }));
      await collectResults(env.db);
      expect((await proposals()).find((x) => x.id === again.body.proposalId)).toMatchObject({ status: "failed", receipt: { build: "failed" }, error: "typecheck failed" });
    } finally {
      delete process.env.AGENTOWN_SELFPATCH_DIR;
    }
  });

  it("the Khác → Đề xuất feed reads the proposals", async () => {
    const items = (await env.call(env.owner, "GET", "/api/feed?kind=proposal")).body.items;
    expect(items.some((i: any) => i.proposalId && i.title.startsWith("Review: Draft FAQ"))).toBe(true);
    expect(items.some((i: any) => i.title === "agent action" && i.status === "rejected")).toBe(true);
  });
});
