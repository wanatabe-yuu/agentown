import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setup } from "./helpers.ts";

// The wall calendar: jobs people schedule, plus the robot's and the trash can's own.
type Env = Awaited<ReturnType<typeof setup>>;
let env: Env;
let viewer: string;
const TZ = "Asia/Ho_Chi_Minh";
const brew = (repeat: unknown) => ({ title: "Morning brew", who: { type: "object", id: "machine" }, action: "brew", repeat, timeZone: TZ });

beforeAll(async () => {
  env = await setup();
  viewer = (await env.call(env.owner, "POST", "/api/users", { displayName: "Vic", roleId: "viewer" })).body.token;
  const w = await env.call(env.owner, "GET", "/api/world");
  const parts = [{ shape: "box" }];
  expect(
    (await env.call(env.owner, "PUT", "/api/world", {
      revision: w.body.revision,
      world: {
        floors: [{ id: "f1", name: "Floor 1", rooms: [{ id: "office", name: "Office", department: "eng", area: { x: 0, z: 0, w: 10, d: 10 } }] }],
        kinds: {
          robot: { name: "Cleaning robot", category: "dynamic", look: { parts }, cleaner: {}, states: [{ id: "idle", name: "Idle" }, { id: "sweeping", name: "Sweeping" }] },
          bin: { name: "Trash can", category: "dynamic", look: { parts }, trash: {} },
          wall: { name: "Wall calendar", category: "static", look: { parts }, calendar: {} },
          machine: { name: "Coffee machine", category: "dynamic", look: { parts }, states: [{ id: "idle", name: "Idle" }, { id: "brewing", name: "Brewing" }], actions: [{ id: "brew", name: "Brew", state: "brewing", seconds: 60 }] },
        },
        objects: [
          { id: "robot", kind: "robot", room: "office", at: [1, 1], cleaner: { schedule: { at: "02:00", days: [1, 3, 5], timeZone: TZ } } },
          { id: "bin", kind: "bin", room: "office", at: [2, 2] },
          { id: "cal", kind: "wall", room: "office", at: [5, 0.1] },
          { id: "machine", kind: "machine", room: "office", at: [3, 3] },
        ],
      },
    })).status,
  ).toBe(200);
});
afterAll(async () => env.close());

const view = async (from = "2026-10-01", to = "2026-10-31") => (await env.call(env.owner, "GET", `/api/calendar?from=${from}&to=${to}`)).body;

describe("wall calendar", () => {
  it("lists the robot's and the trash can's schedules as weekly jobs", async () => {
    const v = await view();
    const sweep = v.jobs.find((j: { id: string }) => j.id === "builtin:sweep");
    expect(sweep.job).toMatchObject({ who: { type: "object", id: "robot" }, repeat: { type: "weekly", times: [null, "02:00", null, "02:00", null, "02:00", null] }, timeZone: TZ });
    expect(v.jobs.find((j: { id: string }) => j.id === "builtin:empty").job.repeat.times).toEqual(Array(7).fill("03:00"));
  });

  it("only people who may change the world put jobs on it, and jobs must make sense", async () => {
    expect((await env.call(viewer, "POST", "/api/schedules", brew({ type: "once", date: "2026-10-20", at: "08:00" }))).status).toBe(403);
    expect((await env.call(env.owner, "POST", "/api/schedules", { ...brew({ type: "once", date: "2026-10-20", at: "08:00" }), action: "dance" })).status).toBe(400);
    expect((await env.call(env.owner, "POST", "/api/schedules", brew({ type: "weekly", times: Array(7).fill(null) }))).status).toBe(400);
    expect((await env.call(env.owner, "POST", "/api/schedules", { title: "x", who: { type: "agent", id: "lead-eng" }, action: "brew", repeat: { type: "once", date: "2026-10-20", at: "08:00" }, timeZone: TZ })).status).toBe(400);
    expect((await env.call(viewer, "GET", "/api/calendar?from=2026-10-01&to=2026-10-31")).status).toBe(200);
    expect((await env.call(env.owner, "GET", "/api/calendar?from=2026-01-01&to=2026-12-31")).status).toBe(400);
  });

  it("runs a weekly job once on each of its days, at its own time, and keeps the run", async () => {
    // Weekdays at 08:00, Saturday at 09:30, never Sunday.
    const r = await env.call(env.owner, "POST", "/api/schedules", brew({ type: "weekly", times: [null, "08:00", "08:00", "08:00", "08:00", "08:00", "09:30"] }));
    expect(r.status).toBe(201);
    const id = r.body.id;
    // Tuesday 2026-10-20, 07:59 in Ho Chi Minh City (UTC+7): not yet.
    await env.calendar.tick(new Date("2026-10-20T00:59:00Z"));
    expect((await view()).runs.filter((x: { jobId: string }) => x.jobId === id)).toEqual([]);
    // 08:05, then again at 08:20: it brews once.
    await env.calendar.tick(new Date("2026-10-20T01:05:00Z"));
    await env.calendar.tick(new Date("2026-10-20T01:20:00Z"));
    const runs = (await view()).runs.filter((x: { jobId: string }) => x.jobId === id);
    expect(runs).toEqual([expect.objectContaining({ day: "2026-10-20", status: "done" })]);
    expect((await env.db.query("SELECT state FROM object_states WHERE object_id='machine'")).rows[0].state).toBe("brewing");
    // Saturday 09:00 is too early for its 09:30; Sunday never.
    await env.calendar.tick(new Date("2026-10-24T02:00:00Z"));
    await env.calendar.tick(new Date("2026-10-25T01:05:00Z"));
    expect((await view()).runs.filter((x: { jobId: string }) => x.jobId === id)).toHaveLength(1);
    await env.calendar.tick(new Date("2026-10-24T02:31:00Z"));
    expect((await view()).runs.filter((x: { jobId: string }) => x.jobId === id).map((x: { day: string }) => x.day).sort()).toEqual(["2026-10-20", "2026-10-24"]);
  });

  it("runs a one-off job on its day only; an agent's job gives it a task and says why when it cannot", async () => {
    const r = await env.call(env.owner, "POST", "/api/schedules", { title: "Write the weekly report", who: { type: "agent", id: "lead-eng" }, prompt: "Summarize this week.", repeat: { type: "once", date: "2026-10-21", at: "17:00" }, timeZone: TZ });
    expect(r.status).toBe(201);
    await env.calendar.tick(new Date("2026-10-20T10:05:00Z")); // the day before
    await env.calendar.tick(new Date("2026-10-21T10:05:00Z")); // 17:05 on the day
    const runs = (await view()).runs.filter((x: { jobId: string }) => x.jobId === r.body.id);
    expect(runs).toHaveLength(1);
    // The test agent has no API key: the run failed and says so (or, with one, a task was given).
    expect(runs[0].status === "failed" ? runs[0].error : runs[0].taskId).toBeTruthy();
  });

  it("a run is done when the task it gave is done", async () => {
    const id = (await env.call(env.owner, "POST", "/api/schedules", { title: "Standup", who: { type: "agent", id: "lead-eng" }, prompt: "Post the standup.", repeat: { type: "once", date: "2026-10-22", at: "09:00" }, timeZone: TZ })).body.id;
    await env.db.query("INSERT INTO tasks(id, org_id, title, status, created_by) VALUES ('t-sched','agentown','Standup','running','owner')");
    await env.db.query("INSERT INTO schedule_runs(id, org_id, schedule_id, local_day, status, task_id) VALUES ('sr1','agentown',$1,'2026-10-22','done','t-sched')", [id]);
    const status = async () => (await view()).runs.find((x: { jobId: string }) => x.jobId === id).status;
    expect(await status()).toBe("running");
    await env.db.query("UPDATE tasks SET status='done' WHERE id='t-sched'");
    expect(await status()).toBe("done");
  });

  it("a by-hand sweep shows on the day it happened; edits and deletes", async () => {
    await env.db.query("INSERT INTO trash_runs(id, org_id, kind, by, started_at, finished_at) VALUES ('tr1','agentown','sweep','human:owner','2026-10-15T20:00:00Z','2026-10-15T20:01:00Z')");
    expect((await view()).runs).toContainEqual(expect.objectContaining({ jobId: "builtin:sweep", day: "2026-10-16", status: "done" }));
    const id = (await env.call(env.owner, "POST", "/api/schedules", brew({ type: "once", date: "2026-10-30", at: "08:00" }))).body.id;
    expect((await env.call(env.owner, "PUT", `/api/schedules/${id}`, { ...brew({ type: "once", date: "2026-10-31", at: "08:00" }), title: "Late brew" })).status).toBe(200);
    expect((await view()).jobs.find((j: { id: string }) => j.id === id).job).toMatchObject({ title: "Late brew", repeat: { date: "2026-10-31" } });
    expect((await env.call(viewer, "DELETE", `/api/schedules/${id}`)).status).toBe(403);
    expect((await env.call(env.owner, "DELETE", `/api/schedules/${id}`)).status).toBe(204);
    expect((await view()).jobs.some((j: { id: string }) => j.id === id)).toBe(false);
  });
});
