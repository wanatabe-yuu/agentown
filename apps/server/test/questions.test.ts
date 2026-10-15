import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Service } from "../src/service.ts";
import { setup } from "./helpers.ts";

let env: Awaited<ReturnType<typeof setup>>;
let worker: string;
beforeAll(async () => {
  env = await setup();
  const r = await env.call(env.token("lead-eng"), "POST", "/api/agents", { templateId: "engineer-v1", displayName: "Quinn", reportsToAgentId: "lead-eng" });
  worker = r.body.agent.id;
  await env.settle();
});
afterAll(async () => {
  await env.close();
});

const gen = async (id: string) => (await env.service.getRuntimeRow(id)).generation;
const task = async (id: string) => (await env.call(env.owner, "GET", `/api/tasks/${id}`)).body;
const pending = async () => (await env.call(env.owner, "GET", "/api/proposals?status=pending")).body.proposals as any[];
async function start(title: string) {
  const t = (await env.call(env.owner, "POST", "/api/tasks", { title, assigneeAgentId: worker })).body.task;
  const g = await gen(worker);
  await env.call(env.token(worker), "POST", "/api/runtime/heartbeat", { generation: g, state: "idle" });
  const c = await env.call(env.token(worker), "POST", "/api/runs/claim", { generation: g });
  expect(c.body.task.id).toBe(t.id);
  return { id: t.id as string, run: c.body.run.id as string, g };
}
/** The resumed task runs again (with the answer in it) and finishes, out of the next test's way. */
async function finishResumed(id: string) {
  const g = await gen(worker);
  const c = await env.call(env.token(worker), "POST", "/api/runs/claim", { generation: g });
  expect(c.body.task.id).toBe(id);
  expect(c.body.task.description).toMatch(/From the owner/);
  await env.call(env.token(worker), "POST", `/api/runs/${c.body.run.id}/complete`, { generation: g, outcome: "succeeded", summary: "done" });
}
const stop = (run: string, g: number, outcome: "blocked" | "succeeded", summary: string) =>
  env.call(env.token(worker), "POST", `/api/runs/${run}/complete`, { generation: g, outcome, summary });

describe("agents wait for people", () => {
  it("a question blocks the task until the person who gave it answers; the answer goes into the task", async () => {
    const { id, run, g } = await start("Plan the launch party");
    const asked = await env.call(env.token(worker), "POST", `/api/tasks/${id}/ask`, { question: "Indoor or outdoor?", options: ["Indoor", "Outdoor"], fallback: "Indoor" });
    expect(asked.status).toBe(201);
    // Only the agent working on it may ask.
    expect((await env.call(env.token("lead-eng"), "POST", `/api/tasks/${id}/ask`, { question: "?" })).status).toBe(409);
    await stop(run, g, "blocked", "waiting for the owner's answer");
    expect((await task(id)).status).toBe("blocked");
    const q = (await pending()).find((p) => p.id === asked.body.questionId);
    expect(q).toMatchObject({ kind: "question", canDecide: true, payload: { taskId: id, options: ["Indoor", "Outdoor"], fallback: "Indoor" } });
    expect((await env.call(env.token(worker), "POST", `/api/proposals/${q.id}/decide`, { verdict: "approve", note: "Outdoor" })).status).toBe(403);
    await env.call(env.owner, "POST", `/api/proposals/${q.id}/decide`, { verdict: "approve", note: "Outdoor" });
    const after = await task(id);
    expect(after.status).toBe("assigned");
    expect(after.description).toMatch(/Indoor or outdoor\?\nAnswer: Outdoor/);
    await finishResumed(id);
  });

  it("nobody answers in time: the agent goes on with its fallback", async () => {
    const { id, run, g } = await start("Order cups");
    const asked = await env.call(env.token(worker), "POST", `/api/tasks/${id}/ask`, { question: "How many?", fallback: "200", timeoutMinutes: 5 });
    await stop(run, g, "blocked", "waiting");
    await env.db.query("UPDATE proposals SET payload = jsonb_set(payload, '{deadline}', to_jsonb((now() - interval '1 minute')::text)) WHERE id=$1", [asked.body.questionId]);
    await env.service.expireQuestions();
    const after = await task(id);
    expect(after.status).toBe("assigned");
    expect(after.description).toMatch(/no reply before the deadline\): Go with your stated default: 200/);
    await finishResumed(id);
  });

  it("an answer that arrives before the agent stops does not leave the task stuck", async () => {
    const { id, run, g } = await start("Pick a venue");
    const asked = await env.call(env.token(worker), "POST", `/api/tasks/${id}/ask`, { question: "Budget?" });
    await env.call(env.owner, "POST", `/api/proposals/${asked.body.questionId}/decide`, { verdict: "approve", note: "500" });
    await stop(run, g, "blocked", "waiting");
    expect((await task(id)).status).toBe("assigned");
    await finishResumed(id);
  });

  it("an approval asked for during a task names the task, and its decision resumes it", async () => {
    const { id, run, g } = await start("Tidy the office");
    const r = await env.call(env.token(worker), "POST", "/api/tools/replace_world/invoke", { args: { revision: 1, world: null } });
    expect(r.status).toBe(202);
    await stop(run, g, "blocked", "waiting for approval");
    const p = (await pending()).find((x) => x.id === r.body.proposalId);
    expect(p.payload.taskId).toBe(id);
    await env.call(env.owner, "POST", `/api/proposals/${p.id}/decide`, { verdict: "reject", note: "not now" });
    const after = await task(id);
    expect(after.status).toBe("assigned");
    expect(after.description).toMatch(/was rejected: not now/);
  });

  it("with approver 'lead', the top agent decides others' requests in a task of its own, and its own go through", async () => {
    expect((await env.call(env.owner, "PUT", "/api/kernel", { approver: "lead" })).status).toBe(200);
    // Review tasks are prompt tasks; the test CEO has no model, which is beside the point here.
    const real = (Service.prototype as any).requirePromptable;
    (Service.prototype as any).requirePromptable = async () => {};
    expect((await env.call(env.owner, "GET", "/api/office/snapshot")).body.leadAgentId).toBe("ceo");
    // lead-eng asks to stop its report: the CEO gets it, not the owner's inbox.
    const r = await env.call(env.token("lead-eng"), "POST", "/api/tools/agent_action/invoke", { args: { id: worker, action: "stop" } });
    expect(r.status).toBe(202);
    const p = (await pending()).find((x) => x.id === r.body.proposalId);
    expect(p.approvers).toEqual({ kind: "lead", agentId: "ceo" });
    const review = (await env.call(env.owner, "GET", "/api/tasks?assignee=ceo")).body.tasks.find((t: any) => t.description.includes(r.body.proposalId));
    expect(review).toMatchObject({ requiresReview: false });
    // Nobody else may decide it; the CEO does.
    expect((await env.call(env.token("lead-eng"), "POST", `/api/proposals/${p.id}/decide`, { verdict: "approve" })).status).toBe(403);
    const ok = await env.call(env.token("ceo"), "POST", `/api/proposals/${p.id}/decide`, { verdict: "approve", note: "fine" });
    expect(ok.body.proposal.status).toBe("applied");
    expect((await env.service.getAgentRow(worker)).desired_runtime).toBe("stopped");
    // The CEO's own request runs at once.
    const own = await env.call(env.token("ceo"), "POST", "/api/tools/agent_action/invoke", { args: { id: worker, action: "start" } });
    expect(own.body.status).toBe("applied");
    (Service.prototype as any).requirePromptable = real;
    // A lead that cannot take the review (no model) hands it back to the owner.
    const back = await env.call(env.token("lead-eng"), "POST", "/api/tools/agent_action/invoke", { args: { id: worker, action: "restart" } });
    expect((await pending()).find((x) => x.id === back.body.proposalId).approvers).toEqual({ kind: "owner" });
    await env.call(env.owner, "PUT", "/api/kernel", { approver: "owner" });
  });
});
