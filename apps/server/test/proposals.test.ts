import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  it("the Khác → Đề xuất feed reads the proposals", async () => {
    const items = (await env.call(env.owner, "GET", "/api/feed?kind=proposal")).body.items;
    expect(items.some((i: any) => i.proposalId && i.title.startsWith("Review: Draft FAQ"))).toBe(true);
    expect(items.some((i: any) => i.title === "agent action" && i.status === "rejected")).toBe(true);
  });
});
