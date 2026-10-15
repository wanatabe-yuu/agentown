import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpuMillis, memoryMib } from "@agentown/core";
import { setup } from "./helpers.ts";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  env = await setup();
});
afterAll(async () => {
  await env.close();
});

const teamPods = (teamId: string) => [...env.driver.pods.values()].filter((p) => p.teamId === teamId);
const gen = async (id: string) => (await env.service.getRuntimeRow(id)).generation;

describe("team runtimes", () => {
  it("runs a department's people in one shared runtime sized for its members", async () => {
    expect(teamPods("eng")).toHaveLength(1);
    const eng = (await env.call(env.owner, "GET", "/api/teams")).body.teams.find((t: any) => t.id === "eng");
    expect(eng).toMatchObject({ departmentId: "eng", implicit: true, memberIds: ["lead-eng"], runtime: { ready: true } });
    expect(new Set([...env.driver.pods.values()].map((p) => p.teamId))).toEqual(new Set(["exec", "product", "eng", "ops"]));
  });

  it("adds a member with its declared share in place, and resizes only when the team is idle", async () => {
    const before = teamPods("eng")[0]!;
    const spawned = await env.call(env.token("lead-eng"), "POST", "/api/agents", {
      templateId: "engineer-v1", displayName: "Kim", reportsToAgentId: "lead-eng", resources: { cpu: "300m", memory: "320Mi" },
    });
    expect(spawned.status).toBe(202);
    const kim = spawned.body.agent.id;
    expect(spawned.body.agent).toMatchObject({ teamId: "eng", resources: { cpu: 300, memory: 320, declared: true } });
    expect((await env.call(env.owner, "POST", "/api/agents", { templateId: "engineer-v1", displayName: "Bad", reportsToAgentId: "lead-eng", resources: { cpu: "lots" } })).status).toBe(400);

    // Linh is busy: the new member already runs in the current runtime, the resize waits.
    await env.call(env.token("lead-eng"), "POST", "/api/runtime/heartbeat", { generation: await gen("lead-eng"), state: "idle" });
    await env.call(env.owner, "POST", "/api/tasks", { title: "Busy work", assigneeAgentId: "lead-eng" });
    const claim = await env.call(env.token("lead-eng"), "POST", "/api/runs/claim", { generation: await gen("lead-eng") });
    expect(claim.body.run).toBeTruthy();
    await env.settle();
    expect(teamPods("eng").map((p) => p.name)).toEqual([before.name]);
    expect((await env.service.teamHello("eng")).members.map((m) => m.id)).toEqual(["lead-eng", kim]);
    const pending = (await env.call(env.owner, "GET", "/api/teams")).body.teams.find((t: any) => t.id === "eng");
    expect(pending.runtime.detail).toMatch(/resize to \d+m\/\d+Mi after current work/);

    await env.call(env.token("lead-eng"), "POST", `/api/runs/${claim.body.run.id}/complete`, { generation: await gen("lead-eng"), outcome: "succeeded" });
    await env.settle();
    const after = teamPods("eng");
    expect(after).toHaveLength(1);
    expect(after[0]!.generation).toBe(before.generation + 1);
    const preset = env.instance.runtimeCatalog.find((p) => p.id === (after[0]!.env.AGENTOWN_HARNESS === "claude" ? "claude-v1" : "script-v1"))!;
    const base = { cpu: cpuMillis(preset.resources.cpu), memory: memoryMib(preset.resources.memory) };
    const linhShare = env.service.memberShare(await env.service.getAgentRow("lead-eng"), preset);
    expect(after[0]!.resources).toEqual({ cpu: `${base.cpu + linhShare.cpu + 300}m`, memory: `${base.memory + linhShare.memory + 320}Mi` });
  });

  it("re-declaring a member's share is a permissioned change that resizes the team", async () => {
    const kim = (await env.service.teamHello("eng")).members.find((m) => m.displayName === "Kim")!.id;
    expect((await env.call(env.token("lead-ops"), "PUT", `/api/agents/${kim}/resources`, { cpu: "1" })).status).toBe(403);
    const r = await env.call(env.token("lead-eng"), "PUT", `/api/agents/${kim}/resources`, { cpu: "500m" });
    expect(r.status).toBe(200);
    expect(r.body.resources).toMatchObject({ cpu: 500, memory: 320 });
    const g = teamPods("eng")[0]!.generation;
    await env.settle();
    expect(teamPods("eng")[0]!.generation).toBe(g + 1);
  });

  it("a team runtime starts sessions only for its own running members", async () => {
    const pod = teamPods("eng")[0]!;
    const runtimeToken = env.driver.tokens.get(pod.runtimeId)!;
    const hello = await env.app.inject({ method: "GET", url: "/api/runtime/team", headers: { authorization: `Bearer ${runtimeToken}` } });
    expect(hello.statusCode).toBe(200);
    expect(hello.json()).toMatchObject({ team: { id: "eng" }, generation: pod.generation });
    const kim = hello.json().members.find((m: any) => m.displayName === "Kim").id;
    const session = await env.app.inject({ method: "POST", url: `/api/runtime/team/members/${kim}/session`, headers: { authorization: `Bearer ${runtimeToken}` } });
    expect(session.statusCode).toBe(200);
    const { token } = session.json();
    // The member acts with its own token and grants; the runtime token itself is not an actor.
    const me = await env.app.inject({ method: "GET", url: `/api/agents/${kim}`, headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: kim, teamId: "eng" });
    expect((await env.app.inject({ method: "GET", url: "/api/agents", headers: { authorization: `Bearer ${runtimeToken}` } })).statusCode).toBe(403);
    expect((await env.app.inject({ method: "POST", url: "/api/runtime/team/members/ceo/session", headers: { authorization: `Bearer ${runtimeToken}` } })).statusCode).toBe(403);
    expect((await env.app.inject({ method: "GET", url: "/api/runtime/team", headers: { authorization: `Bearer ${env.owner}` } })).statusCode).toBe(403);
  });

  it("teams come from the organization's structure; people move between them", async () => {
    const cfg = (await env.call(env.owner, "GET", "/api/config")).body;
    const doc = { ...cfg.doc, teams: [{ id: "platform", name: "Platform", department: "eng" }] };
    expect((await env.call(env.owner, "PUT", "/api/config", { revision: cfg.revision, doc: { ...doc, teams: [{ id: "ops", name: "X", department: "eng" }] } })).status).toBe(400);
    const saved = await env.call(env.owner, "PUT", "/api/config", { revision: cfg.revision, doc });
    expect(saved.status).toBe(200);
    const kim = (await env.service.teamHello("eng")).members.find((m) => m.displayName === "Kim")!.id;
    expect((await env.call(env.token("lead-ops"), "PUT", `/api/agents/${kim}/team`, { teamId: "platform" })).status).toBe(403);
    expect((await env.call(env.owner, "PUT", `/api/agents/${kim}/team`, { teamId: "nope" })).status).toBe(400);
    const moved = await env.call(env.owner, "PUT", `/api/agents/${kim}/team`, { teamId: "platform" });
    expect(moved.status).toBe(200);
    expect(moved.body.teamId).toBe("platform");
    await env.settle();
    expect(teamPods("platform")).toHaveLength(1);
    const fresh = await env.instance.org(env.instance.defaultOrgId);
    expect((await fresh.teamHello("eng")).members.map((m) => m.id)).toEqual(["lead-eng"]);
    expect((await fresh.teamHello("platform")).members.map((m) => m.id)).toEqual([kim]);
    // A team with people cannot be removed from the structure.
    const cur = (await env.call(env.owner, "GET", "/api/config")).body;
    expect((await env.call(env.owner, "PUT", "/api/config", { revision: cur.revision, doc: { ...cur.doc, teams: [] } })).status).toBe(400);
  });
});

describe("conversations", () => {
  it("a team channel is shared by its members and the people above them", async () => {
    expect((await env.call(env.token("lead-eng"), "POST", "/api/teams/eng/messages", { text: "Standup: tests are green" })).status).toBe(201);
    expect((await env.call(env.owner, "POST", "/api/teams/eng/messages", { text: "Thanks!" })).status).toBe(201);
    const read = await env.call(env.owner, "GET", "/api/teams/eng/messages");
    const said = read.body.messages.filter((m: any) => !m.system).map((m: any) => [m.author.name, m.text]);
    expect(said).toEqual([["Linh", "Standup: tests are green"], ["Owner", "Thanks!"]].map(([, t]) => [expect.any(String), t]));
    expect(read.body.messages.some((m: any) => m.system && /started "Busy work"/.test(m.text))).toBe(true);
    expect((await env.call(env.token("lead-ops"), "POST", "/api/teams/eng/messages", { text: "hi" })).status).toBe(403);
    expect((await env.call(env.owner, "GET", "/api/teams/nope/messages")).status).toBe(404);
  });

  it("the other feed separates reasoning, tool calls, proposals and events", async () => {
    await env.call(env.owner, "POST", "/api/tasks", { title: "Think aloud", assigneeAgentId: "lead-eng" });
    const g = await gen("lead-eng");
    const claim = await env.call(env.token("lead-eng"), "POST", "/api/runs/claim", { generation: g });
    await env.call(env.token("lead-eng"), "POST", `/api/runs/${claim.body.run.id}/logs`, { generation: g, lines: [{ stream: "agent", line: "I should check the tests first." }, { stream: "agent", line: "$ pnpm test" }] });
    await env.call(env.token("lead-eng"), "POST", `/api/runs/${claim.body.run.id}/complete`, { generation: g, outcome: "succeeded", summary: "done" });
    const self = (await env.call(env.owner, "GET", "/api/feed?kind=self")).body.items;
    expect(self[0]).toMatchObject({ kind: "self", agentId: "lead-eng", teamId: "eng", text: "I should check the tests first." });
    const tool = (await env.call(env.owner, "GET", "/api/feed?kind=tool&teamId=eng")).body.items;
    expect(tool[0]).toMatchObject({ kind: "tool", title: "bash", text: "pnpm test" });
    const proposals = (await env.call(env.owner, "GET", "/api/feed?kind=proposal")).body.items;
    expect(proposals.some((p: any) => p.title === "Review: Think aloud" && p.status === "pending" && p.canDecide)).toBe(true);
    const events = (await env.call(env.owner, "GET", "/api/feed?kind=event&agentId=lead-eng")).body.items;
    expect(events.some((e: any) => e.title === "run.finished")).toBe(true);
    // Reasoning and commands need runtime.logs on that agent.
    expect((await env.call(env.token("lead-ops"), "GET", "/api/feed?kind=self&agentId=lead-eng")).body.items).toEqual([]);
    expect((await env.call(env.owner, "GET", "/api/feed?kind=nope")).status).toBe(400);
  });
});
