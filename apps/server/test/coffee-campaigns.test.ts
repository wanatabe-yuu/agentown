import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";

// QA pass: hard campaigns in the coffee-store template. Several agents in three departments, handouts,
// failures, budgets, stop/resume, a finished goal, and concurrent drivers.
type Env = Awaited<ReturnType<typeof setup>>;
let env: Env;
let boss: string; // owner of the "coffee" organization
type Name = "Kai" | "Linh" | "Omar" | "Ines" | "Bao" | "Mocha" | "Mai" | "Rosa";
const who = {} as Record<Name, string>; // display name -> agent id
const O = "/api/orgs/coffee";

const co = (token: string, method: string, path: string, body?: unknown) => env.call(token, method, `${O}${path}`, body);
const drive = async () => (await env.instance.org("coffee")).driveCampaigns();
const view = async (id: string) => (await co(boss, "GET", `/campaigns/${id}`)).body as { campaign: any; tasks: any[] };
const open = async (body: Record<string, unknown>) => (await co(boss, "POST", "/campaigns", body)).body as { id: string };
const stepTasks = (v: { tasks: any[] }) => v.tasks.filter((t) => t.campaignStep !== null);
const gen = async (id: string) =>
  (await env.db.query("SELECT r.generation FROM team_runtimes r JOIN agents a ON a.org_id=r.org_id AND COALESCE(a.team_id, a.department_id)=r.team_id WHERE a.id=$1", [id])).rows[0].generation as number;

/** Heartbeat and claim the agent's oldest queued task. */
const claim = async (name: Name) => {
  const id = who[name];
  const g = await gen(id);
  await co(env.token(id), "POST", "/runtime/heartbeat", { generation: g, state: "idle" });
  const r = await co(env.token(id), "POST", "/runs/claim", { generation: g });
  return { name, id, g, status: r.status, run: r.body?.run, task: r.body?.task };
};

/** Claim, let the agent's run do `during`, complete the run, then let the campaign driver look again. */
const work = async (name: Name, summary: string, outcome: "succeeded" | "failed" = "succeeded", during?: (c: Awaited<ReturnType<typeof claim>>) => Promise<void>) => {
  const c = await claim(name);
  expect(c.status).toBe(200);
  if (during) await during(c);
  await co(env.token(who[name]), "POST", `/runs/${c.run.id}/complete`, { generation: c.g, outcome, summary });
  await drive();
  return c.task;
};

/** A handout from an agent's running task, filed into the same campaign by its parent. */
const hand = (from: Name, parentTaskId: string, to: Name, title: string) =>
  co(env.token(who[from]), "POST", "/tasks", { title, assigneeAgentId: who[to], parentTaskId, spec: { kind: "prompt" } });

/** Owner closes a campaign the test left open, so no queued step leaks into the next scenario. */
const cleanup = async (id: string) => {
  const v = await view(id);
  if (v.campaign.status === "active") await co(boss, "POST", `/campaigns/${id}/finish`, { outcome: "achieved", summary: "QA cleanup" });
};

beforeAll(async () => {
  env = await setup();
  const created = await env.call(env.owner, "POST", "/api/admin/orgs", { id: "coffee", name: "Coffee", templateId: "coffee-store", owner: { displayName: "Cafe owner" } });
  expect(created.status).toBe(201);
  boss = created.body.ownerToken;
  // Prompt steps need an agent with a key; one shared key for every agent in the café.
  const key = await co(boss, "POST", "/credentials", { name: "Cafe key", provider: "anthropic", apiKey: "sk-test-cafe" });
  expect(key.status).toBe(201);
  const agents = (await env.db.query("SELECT id, display_name FROM agents WHERE org_id='coffee'")).rows;
  for (const a of agents) {
    who[a.display_name as Name] = a.id;
    await co(boss, "PUT", `/agents/${a.id}/config`, { credentialId: key.body.id, model: "claude-haiku-5-5", effort: "medium" });
  }
  await env.settle();
});
afterAll(async () => {
  await env?.close();
});

describe("coffee-store campaigns (QA)", () => {
  it("A. auto launch across departments: handouts stay in the campaign and the next step waits for all of them", async () => {
    const c = await open({ projectId: "autumn-menu", title: "Pumpkin launch", goal: "Pumpkin latte and scone on the menu, poster up", mode: "auto", leadAgentId: who.Kai, maxSteps: 6, maxFailures: 2 });
    let v = await view(c.id);
    expect(v.tasks.map((t) => [t.assigneeAgentId, t.campaignStep])).toEqual([[who.Kai, 1]]);

    const k = await claim("Kai");
    expect(k.task.id).toBe(v.tasks[0].id);
    const scone = await hand("Kai", k.task.id, "Ines", "Bake pumpkin scones");
    const latte = await hand("Kai", k.task.id, "Omar", "Dial in pumpkin latte");
    expect(scone.body.task).toMatchObject({ campaignId: c.id, projectId: "autumn-menu" });
    expect(latte.body.task.campaignId).toBe(c.id);
    // The studio belongs to Rosa's line, not to the front: Kai cannot hand it work.
    expect((await hand("Kai", k.task.id, "Mai", "Design the poster")).status).toBe(403);
    await co(env.token(who.Kai), "POST", `/runs/${k.run.id}/complete`, { generation: k.g, outcome: "succeeded", summary: "scones and latte handed out" });
    await drive();
    v = await view(c.id);
    expect(stepTasks(v)).toHaveLength(1); // step 2 waits for the two handouts

    await work("Ines", "scones: 12 baked, tasted");
    expect(stepTasks(await view(c.id))).toHaveLength(1); // Omar still open
    await work("Omar", "latte recipe approved at 2 shots");
    v = await view(c.id);
    const step2 = stepTasks(v).find((t) => t.campaignStep === 2);
    expect(step2).toMatchObject({ assigneeAgentId: who.Kai });
    expect(step2.description).toContain("scones: 12 baked");
    expect(step2.description).toContain("latte recipe approved");

    // Only the lead closes it; a barista cannot.
    expect((await co(env.token(who.Omar), "POST", `/campaigns/${c.id}/finish`, { outcome: "achieved", summary: "x" })).status).toBe(403);
    await work("Kai", "menu copy and poster brief sent", "succeeded", async () => {
      const done = await co(env.token(who.Kai), "POST", `/campaigns/${c.id}/finish`, { outcome: "achieved", summary: "pumpkin latte and scone are live" });
      expect(done.body).toMatchObject({ status: "achieved" });
    });
    v = await view(c.id);
    expect(v.campaign).toMatchObject({ status: "achieved", summary: "pumpkin latte and scone are live" });
  });

  it("B. failure budget: two failed handouts end the campaign and no further step is started", async () => {
    const c = await open({ projectId: "autumn-menu", title: "Cold brew sprint", goal: "Cold brew batch ready", mode: "auto", leadAgentId: who.Kai, maxFailures: 2, maxSteps: 6 });
    const k = await claim("Kai");
    await hand("Kai", k.task.id, "Linh", "Brew cold brew");
    await hand("Kai", k.task.id, "Ines", "Roast cold brew beans");
    await co(env.token(who.Kai), "POST", `/runs/${k.run.id}/complete`, { generation: k.g, outcome: "succeeded", summary: "two handouts" });
    await drive();
    await work("Linh", "machine broken", "failed");
    expect((await view(c.id)).campaign.status).toBe("active"); // one failure is under the limit
    await work("Ines", "beans out of stock", "failed");
    const v = await view(c.id);
    expect(v.campaign).toMatchObject({ status: "failed", failures: 2 });
    expect(v.campaign.summary).toContain("2 tasks failed");
    expect(stepTasks(v)).toHaveLength(1);
  });

  it("C. two drivers at once (sweep plus task event) neither duplicate the step nor stop a healthy campaign", async () => {
    const c = await open({ projectId: "socials", title: "Mocha reel", goal: "Post a reel", mode: "manual", leadAgentId: who.Mocha, maxSteps: 4 });
    // Flip to auto without the driver, so eight drivers race on the first step.
    await env.db.query("UPDATE campaigns SET mode='auto' WHERE id=$1", [c.id]);
    const svc = await env.instance.org("coffee");
    await Promise.all(Array.from({ length: 8 }, () => svc.driveCampaign(c.id).catch(() => {})));
    const v = await view(c.id);
    expect(v.campaign.status).toBe("active");
    expect(stepTasks(v)).toHaveLength(1);
    await cleanup(c.id);
  });

  it("D. an achieved campaign can be reopened by the owner (the UI's Reopen): counts start over, a new step comes", async () => {
    const c = await open({ projectId: "autumn-menu", title: "Tasting night", goal: "Tasting night booked", mode: "auto", leadAgentId: who.Kai });
    await work("Kai", "booked", "succeeded", async () => {
      await co(env.token(who.Kai), "POST", `/campaigns/${c.id}/finish`, { outcome: "achieved", summary: "booked" });
    });
    // Only the creator or the owner reopens it.
    expect((await co(env.token(who.Omar), "PATCH", `/campaigns/${c.id}`, { status: "active" })).status).toBe(403);
    const reopen = await co(boss, "PATCH", `/campaigns/${c.id}`, { status: "active" });
    // The old step no longer counts; the step it starts right away is the first of the new run.
    expect(reopen.body).toMatchObject({ status: "active", steps: 1, summary: null });
    expect(stepTasks(await view(c.id)).map((t) => t.campaignStep).sort()).toEqual([1, 2]);
    await cleanup(c.id);
  });

  it("E. a barista outside the campaign cannot steer, close, or hand over its lead", async () => {
    const c = await open({ projectId: "autumn-menu", title: "Menu sign", goal: "Sign printed", mode: "auto", leadAgentId: who.Kai });
    expect((await co(env.token(who.Omar), "PATCH", `/campaigns/${c.id}`, { status: "stopped" })).status).toBe(403);
    expect((await co(env.token(who.Omar), "POST", `/campaigns/${c.id}/finish`, { outcome: "achieved", summary: "x" })).status).toBe(403);
    expect((await co(env.token(who.Omar), "PATCH", `/campaigns/${c.id}`, { leadAgentId: who.Omar })).status).toBe(403);
    expect((await view(c.id)).campaign.leadAgentId).toBe(who.Kai);
    await cleanup(c.id);
  });

  it("F. stop mid-step, then resume: the open step is not duplicated and the step counter restarts", async () => {
    const c = await open({ projectId: "autumn-menu", title: "Gift cards", goal: "Gift cards on sale", mode: "auto", leadAgentId: who.Kai, maxSteps: 3 });
    await co(boss, "PATCH", `/campaigns/${c.id}`, { status: "stopped" });
    await drive();
    expect((await view(c.id)).tasks).toHaveLength(1); // a stopped campaign takes no step
    await co(boss, "PATCH", `/campaigns/${c.id}`, { status: "active" });
    await drive();
    const v = await view(c.id);
    expect(v.tasks).toHaveLength(1); // step 1 is still open: no duplicate
    expect(v.campaign).toMatchObject({ status: "active", steps: 0 });
    await cleanup(c.id);
  });

  it("G. step budget: with two steps and no goal reached, the campaign fails after step two", async () => {
    const c = await open({ projectId: "autumn-menu", title: "Espresso course", goal: "Certify 4 baristas", mode: "auto", leadAgentId: who.Kai, maxSteps: 2, maxFailures: 5 });
    await work("Kai", "step one: planned the course");
    await work("Kai", "step two: first session scheduled");
    const v = await view(c.id);
    expect(v.campaign.status).toBe("failed");
    expect(v.campaign.summary).toContain("used all 2 steps");
    expect(stepTasks(v)).toHaveLength(2);
  });

  it("I. the lead reads a campaign task from a team it cannot see (Bao, roastery), to put results together", async () => {
    const c = await open({ projectId: "autumn-menu", title: "New roast", goal: "Roast profile by Bao, summed up by Kai", mode: "manual", leadAgentId: who.Kai });
    const roast = (await co(boss, "POST", "/tasks", { title: "Roast profile", assigneeAgentId: who.Bao, campaignId: c.id, spec: { kind: "prompt" } })).body.task;
    const other = (await co(boss, "POST", "/tasks", { title: "Not in a campaign", assigneeAgentId: who.Bao, spec: { kind: "prompt" } })).body.task;
    expect((await co(env.token(who.Kai), "GET", `/tasks/${roast.id}`)).status).toBe(200);
    expect((await co(env.token(who.Kai), "GET", `/tasks/${other.id}`)).status).toBe(403);
    for (const t of [roast, other]) await co(boss, "POST", `/tasks/${t.id}/cancel`, {});
    await co(boss, "PATCH", `/campaigns/${c.id}`, { status: "stopped" });
  });

  it("H. goal met while handouts are queued: queued ones are cancelled, a running one is left alone", async () => {
    const c = await open({ projectId: "autumn-menu", title: "Latte art week", goal: "Latte art week run", mode: "auto", leadAgentId: who.Kai });
    const k = await claim("Kai");
    const queued = await hand("Kai", k.task.id, "Linh", "Print latte art cards");
    const running = await hand("Kai", k.task.id, "Omar", "Run the latte art demo");
    const om = await claim("Omar");
    expect(om.task.id).toBe(running.body.task.id);
    await co(env.token(who.Kai), "POST", `/campaigns/${c.id}/finish`, { outcome: "achieved", summary: "demo run by Omar" });
    await co(env.token(who.Kai), "POST", `/runs/${k.run.id}/complete`, { generation: k.g, outcome: "succeeded", summary: "wrapped" });
    await co(env.token(who.Omar), "POST", `/runs/${om.run.id}/complete`, { generation: om.g, outcome: "succeeded", summary: "demo done" });
    const v = await view(c.id);
    expect(v.tasks.find((t) => t.id === queued.body.task.id).status).toBe("cancelled");
    expect(v.tasks.find((t) => t.id === running.body.task.id).status).toBe("done");
    expect(v.campaign.status).toBe("achieved");
  });
});
