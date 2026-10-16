import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";

// Play/pause of organizations: stopping is graceful (runs in flight finish, then nothing runs),
// people can only look while it is not running, and another one plays only once it has stopped.
let env: Awaited<ReturnType<typeof setup>>;
const org = (running: boolean, id = "agentown") => env.call(env.owner, "PATCH", `/api/admin/orgs/${id}`, { running });
const state = async (id = "agentown") =>
  ((await env.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${env.owner}` } })).json().orgs as Array<{ id: string; state: string }>).find((o) => o.id === id)?.state;
const gen = async (id: string) => (await env.service.getRuntimeRow(id)).generation;
const startRun = async (title: string) => {
  const t = (await env.call(env.owner, "POST", "/api/tasks", { title, assigneeAgentId: "lead-eng" })).body.task;
  const g = await gen("lead-eng");
  await env.call(env.token("lead-eng"), "POST", "/api/runtime/heartbeat", { generation: g, state: "idle" });
  const c = await env.call(env.token("lead-eng"), "POST", "/api/runs/claim", { generation: g });
  expect(c.body.task.id).toBe(t.id);
  return { task: t.id as string, run: c.body.run.id as string, g };
};
const wanted = async () => (await (await env.instance.org("agentown")).teamPlans()).some((p) => p.wanted);

beforeAll(async () => {
  env = await setup();
  expect((await env.call(env.owner, "POST", "/api/admin/orgs", { id: "factory", name: "Factory", templateId: "factory", owner: { userId: "owner" } })).status).toBe(201);
  // One plays at a time: the second organization starts stopped.
  await org(false, "factory");
});
afterAll(async () => {
  await env?.close();
});

describe("organizations stop gracefully, play one at a time, and queue a start", () => {
  it("stopping lets the run in flight finish, takes no new work, lets people only look, then stops the runtimes", async () => {
    const r = await startRun("Long job");
    await env.call(env.owner, "POST", "/api/tasks", { title: "Queued job", assigneeAgentId: "lead-eng" });

    expect((await org(false)).status).toBe(200);
    expect(await state()).toBe("pausing");
    expect(await wanted()).toBe(true); // the runtime stays up while the run finishes
    // Nothing new starts, and people can only look.
    expect((await env.call(env.token("lead-eng"), "POST", "/api/runs/claim", { generation: r.g })).status).toBe(204);
    expect((await env.call(env.owner, "POST", "/api/tasks", { title: "x", assigneeAgentId: "lead-eng" })).status).toBe(409);
    expect((await env.call(env.owner, "GET", "/api/tasks")).status).toBe(200);
    // Playing another one meanwhile queues it: it starts once this one has stopped.
    expect((await org(true, "factory")).status).toBe(200);
    expect(await state("factory")).toBe("starting");
    expect(await state()).toBe("pausing");

    // The run finishes normally; then the org is paused and its runtimes go.
    expect((await env.call(env.token("lead-eng"), "POST", `/api/runs/${r.run}/complete`, { generation: r.g, outcome: "succeeded", summary: "done" })).status).toBe(200);
    expect((await env.db.query("SELECT status FROM tasks WHERE id=$1", [r.task])).rows[0].status).toBe("review"); // finished, waiting for its reviewer
    await env.instance.settlePausing();
    expect(await state()).toBe("paused");
    expect(await wanted()).toBe(false);
    expect((await env.call(env.owner, "POST", "/api/tasks", { title: "x", assigneeAgentId: "lead-eng" })).status).toBe(409);

    // The queued one started by itself.
    expect(await state("factory")).toBe("running");
    // Playing this one again stops factory gracefully (nothing runs there, so at once) and starts this one.
    expect((await org(true)).status).toBe(200);
    expect(await state("factory")).toBe("paused");
    expect(await state()).toBe("running");
    const again = await env.call(env.token("lead-eng"), "POST", "/api/runs/claim", { generation: r.g });
    expect(again.body.task.title).toBe("Queued job");
    await env.call(env.token("lead-eng"), "POST", `/api/runs/${again.body.run.id}/complete`, { generation: r.g, outcome: "succeeded", summary: "done" });
  });

  it("a run still going at the end of the grace period is cut: its task waits in the queue without using a retry", async () => {
    const r = await startRun("Endless job");
    const before = (await env.db.query("SELECT attempt, max_attempts FROM tasks WHERE id=$1", [r.task])).rows[0];
    await org(false);
    await env.instance.settlePausing(); // within the grace period: still stopping
    expect(await state()).toBe("pausing");
    await env.instance.settlePausing(0); // grace period over
    expect(await state()).toBe("paused");
    const after = (await env.db.query("SELECT status, attempt, max_attempts FROM tasks WHERE id=$1", [r.task])).rows[0];
    expect(after.status).toBe("assigned");
    expect(after.max_attempts - after.attempt).toBe(before.max_attempts - before.attempt);
    expect((await env.db.query("SELECT status FROM task_runs WHERE id=$1", [r.run])).rows[0].status).toBe("lost");
    await org(true);
  });

  it("a question waiting when it stopped keeps the time it had left", async () => {
    const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
    await env.db.query(
      `INSERT INTO proposals(id, org_id, kind, title, proposer, payload, status, source_type, source_id)
       VALUES ('p-q-pause','agentown','question','Which day?','agent:lead-eng',$1,'pending','question','q-pause')`,
      [JSON.stringify({ taskId: "none", question: "Which day?", deadline })],
    );
    await env.db.query("UPDATE organizations SET paused_at = now() - interval '1 hour', stopped_at = now() WHERE id='agentown'");
    expect((await org(true)).status).toBe(200);
    const moved = new Date((await env.db.query("SELECT payload->>'deadline' AS d FROM proposals WHERE id='p-q-pause'")).rows[0].d).getTime();
    expect(Math.abs(moved - (new Date(deadline).getTime() + 3600_000))).toBeLessThan(60_000);
  });
});
