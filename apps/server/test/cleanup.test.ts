import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";

// The cleaning robot sweeps what is old into the trash can; the trash can deletes it for good.
type Env = Awaited<ReturnType<typeof setup>>;
let env: Env;
let viewer: string;
const old = "now() - interval '200 days'";

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
          robot: { name: "Cleaning robot", category: "dynamic", look: { parts }, cleaner: {}, behaviors: [{ type: "roam" }], states: [{ id: "idle", name: "Idle" }, { id: "sweeping", name: "Sweeping" }] },
          bin: { name: "Trash can", category: "dynamic", look: { parts }, trash: {}, states: [{ id: "closed", name: "Closed" }, { id: "emptying", name: "Emptying" }] },
        },
        objects: [
          { id: "robot", kind: "robot", room: "office", at: [1, 1], cleaner: { schedule: { at: "02:00", timeZone: "Asia/Ho_Chi_Minh" }, history: { enabled: true, days: 90 }, chats: { enabled: true }, assets: { enabled: true }, downloads: { enabled: false } } },
          { id: "bin", kind: "bin", room: "office", at: [2, 2], trash: { schedule: { at: "03:00", timeZone: "Asia/Ho_Chi_Minh" }, keepDays: 7 } },
        ],
      },
    })).status,
  ).toBe(200);
  // Old and new leftovers of every kind the robot sweeps.
  const q = (sql: string) => env.db.query(sql);
  await q(`INSERT INTO agent_events(org_id, type, at) VALUES ('agentown','test.old', ${old}), ('agentown','test.new', now())`);
  await q(`INSERT INTO team_messages(org_id, team_id, author_kind, author_id, text, at) VALUES ('agentown','eng','human','owner','old', ${old}), ('agentown','eng','human','owner','new', now())`);
  await q(`INSERT INTO tasks(id, org_id, title, status, created_by, updated_at) VALUES ('t-old','agentown','Old','done','owner', ${old}), ('t-new','agentown','New','running','owner', now())`);
  await q(`INSERT INTO task_runs(id, task_id, agent_id, attempt, idempotency_key, runtime_generation, lease_expires_at, status, finished_at)
           VALUES ('r-old','t-old','lead-eng',1,'t-old:1',1,now(),'succeeded', ${old}), ('r-new','t-new','lead-eng',1,'t-new:1',1,now(),'running', NULL)`);
  await q(`INSERT INTO artifacts(id, task_id, run_id, agent_id, name, content_type, content, sha256) VALUES
           ('art-old','t-old','r-old','lead-eng','out.txt','text/plain','\\x6869','x'), ('art-new','t-new','r-new','lead-eng','out.txt','text/plain','\\x6869','y')`);
  await q(`INSERT INTO owner_chats(id, org_id, user_id, config, archived_at) VALUES ('chat-old','agentown','owner','{}', ${old}), ('chat-live','agentown','owner','{}', NULL)`);
  await q(`INSERT INTO assets(id, org_id, kind, name, content_type, size, sha256, content, created_by, created_at) VALUES ('asset-old','agentown','texture','old.png','image/png',2,'s1','\\x0102','owner', ${old})`);
  // Team runtimes answer the robot's shell: two old outputs moved, 8 KiB.
  env.driver.execReply = (cmd) => (cmd.includes("move") || cmd.includes("dry") ? "moved 2 8\n" : "gone\n");
});
afterAll(async () => env.close());

const count = async (sql: string) => Number((await env.db.query(sql)).rows[0].n);

describe("cleaning robot and trash can", () => {
  it("shows both with their settings filled in", async () => {
    const v = await env.call(env.owner, "GET", "/api/cleanup");
    expect(v.status).toBe(200);
    expect(v.body.cleaner).toMatchObject({ objectId: "robot", settings: { enabled: true, workspace: { enabled: true, days: 14 }, history: { enabled: true, days: 90 }, schedule: { at: "02:00", days: [0, 1, 2, 3, 4, 5, 6] } } });
    expect(v.body.trash).toMatchObject({ objectId: "bin", settings: { keepDays: 7, schedule: { at: "03:00" } } });
  });

  it("a preview counts what a sweep would take and moves nothing", async () => {
    const r = await env.call(env.owner, "POST", "/api/cleanup/sweep", { dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body.parts.history.count).toBeGreaterThanOrEqual(3); // an event, a message, a file
    expect(r.body.parts.chats.count).toBe(1);
    expect(r.body.parts.assets.count).toBe(1);
    expect(await count("SELECT count(*) AS n FROM trash_items")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM agent_events WHERE type='test.old'")).toBe(1);
  });

  it("only people who may change the world run it", async () => {
    expect((await env.call(viewer, "POST", "/api/cleanup/sweep", {})).status).toBe(403);
    expect((await env.call(viewer, "POST", "/api/cleanup/empty", {})).status).toBe(403);
  });

  it("a sweep moves what is old into the trash and leaves the rest", async () => {
    const audit = await count("SELECT count(*) AS n FROM audit_events");
    const r = await env.call(env.owner, "POST", "/api/cleanup/sweep", {});
    expect(r.status).toBe(200);
    expect(await count("SELECT count(*) AS n FROM agent_events WHERE type='test.old'")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM agent_events WHERE type='test.new'")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM team_messages")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM artifacts")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM assets")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM owner_chats WHERE trashed_at IS NOT NULL")).toBe(1);
    expect(r.body.parts.workspace).toEqual({ count: 2, bytes: 8192 });
    // The old task's output folder went as an argument, never through the shell.
    expect(env.driver.execs.some((c) => c.includes("move") && c.includes("members/lead-eng/tasks/t-old"))).toBe(true);
    expect(env.driver.execs.some((c) => c.includes("members/lead-eng/tasks/t-new"))).toBe(false);
    // The robot shows it is sweeping, and the audit log only grew.
    expect((await env.db.query("SELECT state FROM object_states WHERE object_id='robot'")).rows[0].state).toBe("sweeping");
    expect(await count("SELECT count(*) AS n FROM audit_events")).toBeGreaterThan(audit);
    const v = await env.call(env.owner, "GET", "/api/cleanup");
    expect(v.body.items.map((i: { part: string }) => i.part).sort()).toEqual(expect.arrayContaining(["assets", "chats", "history", "workspace"]));
  });

  it("anything in the trash can go back", async () => {
    const items = (await env.call(env.owner, "GET", "/api/cleanup")).body.items as Array<{ id: string; label: string; part: string }>;
    for (const label of ["Activity", "Unused art", "Archived chats"]) {
      const item = items.find((i) => i.label === label)!;
      expect((await env.call(env.owner, "POST", `/api/cleanup/items/${item.id}/restore`, {})).status).toBe(200);
    }
    expect(await count("SELECT count(*) AS n FROM agent_events WHERE type='test.old'")).toBe(1);
    expect((await env.db.query("SELECT content FROM assets WHERE id='asset-old'")).rows[0].content).toEqual(Buffer.from([1, 2]));
    expect(await count("SELECT count(*) AS n FROM owner_chats WHERE trashed_at IS NOT NULL")).toBe(0);
  });

  it("emptying deletes for good", async () => {
    const r = await env.call(env.owner, "POST", "/api/cleanup/empty", {});
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBeGreaterThan(0);
    expect(await count("SELECT count(*) AS n FROM trash_items")).toBe(0);
    expect(env.driver.execs.some((c) => c.join(" ").includes("rm -rf /workspace/.agentown-trash/"))).toBe(true);
  });

  it("each runs once a day at its own time in its own time zone", async () => {
    const runs = () => count("SELECT count(*) AS n FROM trash_runs WHERE by='schedule'");
    // 01:30 in Ho Chi Minh City (UTC+7): neither is due yet.
    await env.cleanup.tick(new Date("2026-10-20T18:30:00Z"));
    expect(await runs()).toBe(0);
    // 02:10 there: the robot sweeps once, however often the clock ticks.
    await env.cleanup.tick(new Date("2026-10-20T19:10:00Z"));
    await env.cleanup.tick(new Date("2026-10-20T19:20:00Z"));
    expect(await count("SELECT count(*) AS n FROM trash_runs WHERE by='schedule' AND kind='sweep'")).toBe(1);
    // 03:05 there: the trash can empties what has waited a week (nothing yet).
    await env.cleanup.tick(new Date("2026-10-20T20:05:00Z"));
    expect(await count("SELECT count(*) AS n FROM trash_runs WHERE by='schedule' AND kind='empty'")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM trash_items")).toBeGreaterThan(0);
    // The next afternoon (16:00 there) is long past 02:00: no sweep until the night after.
    await env.cleanup.tick(new Date("2026-10-21T09:00:00Z"));
    expect(await count("SELECT count(*) AS n FROM trash_runs WHERE by='schedule' AND kind='sweep'")).toBe(1);
  });
});
