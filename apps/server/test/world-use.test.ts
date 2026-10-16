import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";

// Agents use everything in the world within their permissions; what they may not do
// themselves is asked of the owner, who carries it out (or grants the permission).
type Env = Awaited<ReturnType<typeof setup>>;
let env: Env;
const TZ = "Asia/Ho_Chi_Minh";
const lead = () => env.token("lead-eng");
const invoke = (token: string, id: string, args: unknown) => env.call(token, "POST", `/api/tools/${id}/invoke`, { args });
const approve = async (proposalId: string) => {
  const r = await env.call(env.owner, "POST", `/api/proposals/${proposalId}/decide`, { verdict: "approve" });
  expect(r.status).toBe(200);
  return r.body;
};
const once = (date: string) => ({ type: "once", date, at: "09:00" });

beforeAll(async () => {
  env = await setup();
  env.driver.execReply = () => "moved 0 0\n";
  const w = await env.call(env.owner, "GET", "/api/world");
  const parts = [{ shape: "box" }];
  const states = [{ id: "idle", name: "Idle" }, { id: "on", name: "On" }];
  expect(
    (await env.call(env.owner, "PUT", "/api/world", {
      revision: w.body.revision,
      world: {
        floors: [{ id: "f1", name: "Floor 1", rooms: [
          { id: "eng", name: "Engineering", department: "eng", area: { x: 0, z: 0, w: 10, d: 10 } },
          { id: "ops", name: "Operations", department: "ops", area: { x: 10, z: 0, w: 10, d: 10 } },
        ] }],
        kinds: {
          machine: { name: "Coffee machine", category: "dynamic", look: { parts }, states, actions: [{ id: "brew", name: "Brew", state: "on" }] },
          lamp: { name: "Lamp", category: "dynamic", look: { parts }, states, actions: [{ id: "dim", name: "Dim", state: "on" }] },
          robot: { name: "Cleaning robot", category: "dynamic", look: { parts }, cleaner: {} },
          bin: { name: "Trash can", category: "dynamic", look: { parts }, trash: {} },
          wall: { name: "Wall calendar", category: "static", look: { parts }, calendar: {} },
        },
        objects: [
          { id: "machine", kind: "machine", room: "eng", at: [2, 2] },
          { id: "lamp", kind: "lamp", room: "ops", at: [2, 2] },
          { id: "robot", kind: "robot", room: "eng", at: [4, 4] },
          { id: "bin", kind: "bin", room: "eng", at: [5, 5] },
          { id: "cal", kind: "wall", room: "eng", at: [5, 0.1] },
        ],
      },
    })).status,
  ).toBe(200);
});
afterAll(async () => env.close());

describe("agents use the world", () => {
  it("see what is there, what they can reach and what each thing is for", async () => {
    const r = await invoke(lead(), "objects", {});
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.result.objects.map((o: { id: string }) => [o.id, o]));
    expect(by.machine).toMatchObject({ reachable: true, actions: [{ id: "brew" }] });
    expect(by.lamp.reachable).toBe(false);
    expect(by.cal.use).toContain("agentown calendar");
    expect(by.robot.use).toContain("agentown cleanup");
  });

  it("use an object within reach; one in another department's room is refused", async () => {
    expect((await invoke(lead(), "use_object", { objectId: "machine", action: "brew" })).body).toMatchObject({ status: "applied", result: { state: "on", by: { type: "agent", id: "lead-eng" } } });
    expect((await invoke(lead(), "use_object", { objectId: "lamp", action: "dim" })).status).toBe(403);
  });

  it("put tasks for themselves on the calendar; for someone outside their team it asks the owner", async () => {
    const mine = await invoke(lead(), "schedule", { op: "create", job: { title: "Standup notes", who: { type: "agent", id: "lead-eng" }, prompt: "Write the standup notes.", repeat: once("2026-11-02"), timeZone: TZ } });
    expect(mine.body.status).toBe("applied");
    expect((await env.db.query("SELECT created_by FROM schedules WHERE id=$1", [mine.body.result.id])).rows[0].created_by).toBe("agent:lead-eng");
    const boss = await invoke(lead(), "schedule", { op: "create", job: { title: "Board deck", who: { type: "agent", id: "ceo" }, prompt: "Prepare the deck.", repeat: once("2026-11-03"), timeZone: TZ } });
    expect(boss.body).toMatchObject({ status: "pending" });
  });

  it("an object's job needs leave to change the world: asked, approved, the owner sets it up", async () => {
    const job = { title: "Morning brew", who: { type: "object", id: "machine" }, action: "brew", repeat: { type: "weekly", times: [null, "08:00", "08:00", "08:00", "08:00", "08:00", null] }, timeZone: TZ };
    const r = await invoke(lead(), "schedule", { op: "create", job });
    expect(r.body.status).toBe("pending");
    // Asking again waits on the same request.
    expect((await invoke(lead(), "schedule", { op: "create", job })).body.proposalId).toBe(r.body.proposalId);
    await approve(r.body.proposalId);
    const row = (await env.db.query("SELECT created_by FROM schedules WHERE job->>'title'='Morning brew'")).rows[0];
    expect(row.created_by).toMatch(/^human:/);
  });

  it("an agent sees the objects' jobs and its team's, not other teams'", async () => {
    await env.call(env.owner, "POST", "/api/schedules", { title: "Ops review", who: { type: "agent", id: "lead-ops" }, prompt: "Review ops.", repeat: once("2026-11-04"), timeZone: TZ });
    const titles = (await invoke(lead(), "calendar", { from: "2026-11-01", to: "2026-11-30" })).body.result.jobs.map((j: { job: { title: string } }) => j.job.title);
    expect(titles).toEqual(expect.arrayContaining(["Standup notes", "Morning brew", "Sweep into the trash"]));
    expect(titles).not.toContain("Ops review");
  });

  it("the cleaning robot: anyone looks, a sweep without leave is asked and done by the owner", async () => {
    expect((await invoke(lead(), "cleanup", { op: "view" })).body).toMatchObject({ status: "applied", result: { cleaner: { objectId: "robot" } } });
    const r = await invoke(lead(), "cleanup", { op: "sweep" });
    expect(r.body.status).toBe("pending");
    await approve(r.body.proposalId);
    expect((await env.db.query("SELECT by FROM trash_runs WHERE kind='sweep'")).rows[0].by).toMatch(/^human:/);
  });

  it("asks for a lasting permission; granted, it acts on its own", async () => {
    expect((await invoke(env.owner, "request_permission", { action: "org.design", reason: "x" })).status).toBe(400);
    const r = await invoke(lead(), "request_permission", { action: "org.design", reason: "to keep the coffee schedule", agentId: "ceo" });
    expect(r.body.status).toBe("pending");
    await approve(r.body.proposalId);
    // Granted to the agent who asked, whatever it named.
    expect((await env.db.query("SELECT principal_id FROM grants WHERE action='org.design'")).rows.map((g) => g.principal_id)).toEqual(["lead-eng"]);
    const job = { title: "Afternoon brew", who: { type: "object", id: "machine" }, action: "brew", repeat: once("2026-11-05"), timeZone: TZ };
    expect((await invoke(lead(), "schedule", { op: "create", job })).body.status).toBe("applied");
    expect((await invoke(lead(), "cleanup", { op: "preview" })).body.status).toBe("applied");
  });
});
