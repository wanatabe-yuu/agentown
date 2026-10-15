import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Service } from "../src/service.ts";
import { setup } from "./helpers.ts";

let env: Awaited<ReturnType<typeof setup>>;
let worker: string;
beforeAll(async () => {
  env = await setup();
  // Campaign steps are prompt tasks; these agents have no model, which is beside the point here.
  (Service.prototype as unknown as { requirePromptable: () => Promise<void> }).requirePromptable = async () => {};
  const r = await env.call(env.token("lead-eng"), "POST", "/api/agents", { templateId: "engineer-v1", displayName: "Cam", reportsToAgentId: "lead-eng" });
  worker = r.body.agent.id;
  await env.settle();
});
afterAll(async () => {
  await env.close();
});

const gen = async (id: string) => (await env.service.getRuntimeRow(id)).generation;
const claim = async (id: string) => {
  const g = await gen(id);
  await env.call(env.token(id), "POST", "/api/runtime/heartbeat", { generation: g, state: "idle" });
  return { g, r: await env.call(env.token(id), "POST", "/api/runs/claim", { generation: g }) };
};
const finish = async (id: string, outcome: "succeeded" | "failed", summary: string) => {
  const { g, r } = await claim(id);
  expect(r.status).toBe(200);
  await env.call(env.token(id), "POST", `/api/runs/${r.body.run.id}/complete`, { generation: g, outcome, summary });
  return r.body.task.id as string;
};
const campaign = async (id: string) => (await env.call(env.owner, "GET", `/api/campaigns/${id}`)).body;
const drive = () => env.service.driveCampaigns();

describe("campaigns", () => {
  it("manual: the campaign's tasks wait; switching it to auto lets them run", async () => {
    const c = (await env.call(env.owner, "POST", "/api/campaigns", { projectId: "website", title: "Launch page", goal: "Ship the launch page", mode: "manual", leadAgentId: worker })).body;
    expect(c).toMatchObject({ status: "active", mode: "manual", projectId: "website" });
    const t = (await env.call(env.owner, "POST", "/api/tasks", { title: "Hero copy", assigneeAgentId: worker, campaignId: c.id, spec: { kind: "playbook", playbook: "noop", args: {} } })).body.task;
    expect(t).toMatchObject({ campaignId: c.id, projectId: "website" });
    // Wrong project for the campaign is refused.
    expect((await env.call(env.owner, "POST", "/api/tasks", { title: "x", assigneeAgentId: worker, projectId: "nope", campaignId: c.id })).status).toBe(400);
    expect((await claim(worker)).r.status).toBe(204);
    // Only the creator or the owner steers it.
    expect((await env.call(env.token(worker), "PATCH", `/api/campaigns/${c.id}`, { mode: "auto" })).status).toBe(403);
    expect((await env.call(env.owner, "PATCH", `/api/campaigns/${c.id}`, { mode: "auto" })).body.mode).toBe("auto");
    const { g, r } = await claim(worker);
    expect(r.body.task.id).toBe(t.id);
    await env.call(env.token(worker), "POST", `/api/runs/${r.body.run.id}/complete`, { generation: g, outcome: "succeeded", summary: "copy written" });
    await env.call(env.owner, "PATCH", `/api/campaigns/${c.id}`, { status: "stopped" });
  });

  it("auto: the lead gets one step at a time, hands work out inside the campaign, and closes it", async () => {
    const c = (await env.call(env.owner, "POST", "/api/campaigns", { projectId: "website", title: "Blog", goal: "Three posts live", mode: "auto", leadAgentId: "lead-eng" })).body;
    let tasks = (await campaign(c.id)).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ assigneeAgentId: "lead-eng", campaignStep: 1, requiresReview: false });
    expect(tasks[0].description).toContain("Three posts live");
    // Nothing new while the step is open.
    await drive();
    expect((await campaign(c.id)).tasks).toHaveLength(1);
    // During the step the lead hands work out; its parent puts it in the campaign.
    const { g, r } = await claim("lead-eng");
    const sub = (await env.call(env.token("lead-eng"), "POST", "/api/tasks", { title: "Post 1", assigneeAgentId: worker, parentTaskId: r.body.task.id, spec: { kind: "playbook", playbook: "noop", args: {} } })).body.task;
    expect(sub.campaignId).toBe(c.id);
    await env.call(env.token("lead-eng"), "POST", `/api/runs/${r.body.run.id}/complete`, { generation: g, outcome: "succeeded", summary: "planned posts" });
    await drive();
    expect((await campaign(c.id)).tasks).toHaveLength(2); // waits for Post 1
    await finish(worker, "succeeded", "post 1 live");
    await drive();
    tasks = (await campaign(c.id)).tasks;
    const step2 = tasks.find((t: any) => t.campaignStep === 2);
    expect(step2.description).toContain("post 1 live");
    // Someone else cannot close it; the lead can.
    expect((await env.call(env.token(worker), "POST", `/api/campaigns/${c.id}/finish`, { outcome: "achieved", summary: "x" })).status).toBe(403);
    const done = await env.call(env.token("lead-eng"), "POST", `/api/campaigns/${c.id}/finish`, { outcome: "achieved", summary: "3 posts live" });
    expect(done.body).toMatchObject({ status: "achieved", summary: "3 posts live" });
    // The step nobody started is no longer needed.
    expect((await campaign(c.id)).tasks.find((t: any) => t.id === step2.id).status).toBe("cancelled");
  });

  it("auto: too many failed tasks end it; resuming counts again from there", async () => {
    const c = (await env.call(env.owner, "POST", "/api/campaigns", { projectId: "website", title: "Flaky", goal: "g", mode: "auto", leadAgentId: worker, maxFailures: 2 })).body;
    await finish(worker, "failed", "nope 1");
    await drive();
    await finish(worker, "failed", "nope 2");
    await drive();
    const failed = (await campaign(c.id)).campaign;
    expect(failed).toMatchObject({ status: "failed", failures: 2 });
    expect(failed.summary).toMatch(/2 tasks failed/);
    const resumed = (await env.call(env.owner, "PATCH", `/api/campaigns/${c.id}`, { status: "active" })).body;
    expect(resumed).toMatchObject({ status: "active", failures: 0 });
    expect((await campaign(c.id)).tasks.filter((t: any) => t.campaignStep).length).toBe(3);
    await env.call(env.owner, "PATCH", `/api/campaigns/${c.id}`, { status: "stopped" });
  });

  it("campaigns are listed per project with their progress", async () => {
    const list = (await env.call(env.owner, "GET", "/api/campaigns?projectId=website")).body.campaigns;
    expect(list.map((c: any) => c.title)).toEqual(expect.arrayContaining(["Launch page", "Blog", "Flaky"]));
    expect(list.find((c: any) => c.title === "Blog").tasks).toMatchObject({ done: 2, cancelled: 1 });
  });
});
