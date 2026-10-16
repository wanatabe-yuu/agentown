import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";
import { emptyUsage, type ChatModel, type Message, type ModelInput } from "../src/chat/types.ts";
import { chatInstructionTemplate } from "@agentown/core";
import { migrate } from "../src/db.ts";

let env: Awaited<ReturnType<typeof setup>>;
let key: string, worker: string, viewer: string, cat: string, dog: string, desk: string;
let inputs: ModelInput[] = [];
let plan: Message[] = [];
const fake: ChatModel = {
  async info() { return { contextWindow: 100000, maxOutputTokens: 8000, nativeCompaction: false, efforts: ["medium"] }; },
  async count(i) { return { tokens: 1200 + i.messages.length * 50, mode: "estimated" }; },
  async complete(i) { inputs.push({ ...i, messages: structuredClone(i.messages) }); return { message: plan.shift() ?? { role: "assistant", text: "Discussed without a task." }, usage: { ...emptyUsage(), inputTokens: 100, outputTokens: 10, requests: 1 } }; },
  async compact() { return { message: { role: "user", text: "Historical summary" }, usage: { ...emptyUsage(), requests: 1 } }; },
};
const config = () => ({ credentialId: key, model: "claude-haiku-5-5", effort: "medium", approvalMode: "important" });
const path = (type: string, subject: string, suffix = "") => `/api/entity-chats/${type}/${subject}${suffix}`;
const call = (type: string, subject: string, method: string, suffix = "", body?: unknown, token?: string) => env.call(token ?? env.owner, method, path(type, subject, suffix), body);
const create = async (type: string, subject: string) => { const r = await call(type, subject, "POST", "", config()); expect(r.status).toBe(201); return r.body.id as string; };
const send = async (type: string, subject: string, id: string, text = "Analyze our next steps") => {
  expect((await call(type, subject, "POST", `/${id}/messages`, { requestId: crypto.randomUUID(), text })).status).toBe(200);
  await env.ownerChat.idle(); return (await call(type, subject, "GET", `/${id}`)).body;
};
const tool = (name: string, args: Record<string, unknown>): Message => ({ role: "assistant", text: "A useful follow-up.", calls: [{ id: crypto.randomUUID(), name, args }] });
const setWorld = async (world: unknown) => { const old = await env.call(env.owner, "GET", "/api/world"); return env.call(env.owner, "PUT", "/api/world", { revision: old.body.revision, world }); };

beforeAll(async () => {
  env = await setup(() => fake);
  key = (await env.call(env.owner, "POST", "/api/credentials", { name: "Chat key", apiKey: "sk-test-small-entity" })).body.id;
  worker = (await env.call(env.owner, "POST", "/api/agents", { templateId: "engineer-v1", displayName: "Worker", reportsToAgentId: "lead-eng" })).body.agent.id;
  for (const agent of ["ceo", "lead-eng", "lead-ops", worker]) expect((await env.call(env.owner, "PUT", `/api/agents/${agent}/config`, { credentialId: key, model: "claude-haiku-5-5", effort: "medium", instructions: agent === worker ? "Explain engineering tradeoffs." : "" })).status).toBe(200);
  viewer = (await env.call(env.owner, "POST", "/api/users", { displayName: "Member", roleId: "admin" })).body.token;
  const r = await setWorld({ floors: [{ id: "ground", name: "Ground", rooms: [{ id: "room", name: "Room", area: { x: 0, z: 0, w: 10, d: 10 } }] }],
    kinds: { cat: { name: "Cat", category: "character", look: { character: "cat" }, chat: { instructions: "Enjoy coffee discussions." } }, dog: { name: "Dog", category: "character", look: { character: "dog" }, chat: {} }, desk: { name: "Desk", category: "static", look: { parts: [{ shape: "box" }] } } },
    objects: [{ kind: "cat", room: "room", at: [1, 1], label: "Bean", chat: { instructions: "Be curious." } }, { kind: "dog", room: "room", at: [2, 2], label: "Bark" }, { kind: "desk", room: "room", at: [3, 3] }] });
  expect(r.status).toBe(200); [cat, dog, desk] = r.body.world.objects.map((o: any) => o.id);
  await env.settle();
});
beforeEach(() => { inputs = []; plan = []; });
afterAll(async () => env?.close());

describe("individual conversations", () => {
  it("answers independently of task execution, with per-subject defaults and no keys", async () => {
    const index = (await call("agent", worker, "GET")).body;
    expect(index.defaults).toMatchObject(config());
    expect(index.profile.instructions).toBe("Explain engineering tradeoffs.");
    expect(index.profile.authority).toContain("agent's current task permissions");
    const id = await create("agent", worker);
    const count = (await env.db.query("SELECT count(*)::int n FROM tasks")).rows[0].n;
    const result = await send("agent", worker, id, "Can we discuss an idea?");
    expect(result.run.status).toBe("succeeded"); expect(result.actions).toHaveLength(0);
    expect(result.chat.usage.requests).toBe(1);
    expect((await env.db.query("SELECT count(*)::int n FROM tasks")).rows[0].n).toBe(count);
    expect(inputs[0]!.system).toContain("Explain engineering tradeoffs.");
    expect(inputs[0]!.tools.map(t => t.name)).toEqual(["inspect", "objects", "interact", "calendar", "schedule", "cleanup", "create_task", "task_action", "prepare_self_runtime"]);
    expect(JSON.stringify(inputs)).not.toContain("sk-test-small-entity");
    expect(JSON.stringify(result)).not.toContain("sk-test-small-entity");
  });
  it("isolates history and every write between subjects, owner chat, organizations and users", async () => {
    const id = await create("object", cat);
    await send("object", cat, id, "Only the cat knows this discussion");
    // An object knows its own room only, and furniture does not talk at all.
    expect(inputs.at(-1)!.tools.map(t => t.name)).toEqual(["look_around", "assign_to_ceo"]);
    expect((await call("object", desk, "GET")).status).toBe(409);
    for (const [type, subject] of [["object", dog], ["agent", worker]]) {
      expect((await call(type!, subject!, "GET")).body.chats.some((c: any) => c.id === id)).toBe(false);
      for (const [method, suffix, b] of [["GET", `/${id}`, undefined], ["PUT", `/${id}/config`, config()], ["PUT", `/${id}/archive`, { archived: true }], ["DELETE", `/${id}`, undefined], ["POST", `/${id}/messages`, { requestId: crypto.randomUUID(), text: "Cross subject" }], ["POST", `/${id}/compact`, { requestId: crypto.randomUUID() }], ["POST", `/${id}/stop`, undefined], ["POST", `/${id}/actions/missing`, { approve: true }]] as const) expect((await call(type!, subject!, method, suffix, b)).status).toBe(404);
    }
    expect((await env.call(env.owner, "GET", `/api/owner-chats/${id}`)).status).toBe(404);
    expect((await env.call(env.owner, "GET", "/api/owner-chats")).body.chats).toHaveLength(0);
    for (const token of [viewer, env.token(worker)]) expect((await call("object", cat, "GET", `/${id}`, undefined, token)).status).toBe(403);
    const userId = (await env.instance.authenticate(env.owner))!.id;
    await env.call(env.owner, "POST", "/api/admin/orgs", { id: "entity-other", name: "Other", templateId: "company", owner: { userId } });
    expect((await env.call(env.owner, "GET", `/api/orgs/entity-other/entity-chats/object/${cat}/${id}`)).status).toBe(404);
    expect((await call("object", cat, "GET", `/${id}`)).body.messages[0].text).toContain("Only the cat");
  });
  it("automatically creates a prompt task as the agent, defaults to itself and cannot gain owner rights", async () => {
    const id = await create("agent", worker);
    plan = [tool("create_task", { title: "Analyze prototype", description: "Track concrete follow-up" }), tool("create_task", { title: "Forbidden outside team", assigneeAgentId: "lead-ops" }), tool("patch_world", { revision: 1, operations: [] })];
    const result = await send("agent", worker, id);
    expect(result.actions.map((a: any) => a.status)).toEqual(["applied", "failed", "failed"]);
    const task = result.actions[0].result.task;
    expect(task).toMatchObject({ assigneeAgentId: worker, createdBy: `agent:${worker}`, requiresReview: true, spec: { kind: "prompt" } });
    expect((await env.db.query("SELECT count(*)::int n FROM tasks WHERE title='Forbidden outside team'")).rows[0].n).toBe(0);
  });
  it("CEO can assign concrete work to self aliases but cannot review its own work", async () => {
    const id = await create("agent", "ceo");
    plan = [tool("create_task", { title: "CEO self follow-up", assigneeAgentId: "self", description: "Concrete work with sufficient context." })];
    const view = await send("agent", "ceo", id);
    const task = view.actions[0].result.task;
    expect(task).toMatchObject({ assigneeAgentId: "ceo", createdBy: "agent:ceo", maxAttempts: 5 });
    plan = [tool("task_action", { id: task.id, action: "approve" })];
    const next = await send("agent", "ceo", id);
    const pending = next.actions.find((a: any) => a.status === "pending");
    await call("agent", "ceo", "POST", `/${id}/actions/${pending.id}`, { approve: true });
    await env.ownerChat.idle();
    const end = (await call("agent", "ceo", "GET", `/${id}`)).body;
    expect(end.actions.find((a: any) => a.id === pending.id).status).toBe("failed");
  });
  it("runtime preparation is restricted to the chat subject and waits for owner confirmation", async () => {
    const id = await create("agent", worker);
    const before = (await env.call(env.owner, "GET", `/api/agents/${worker}`)).body.config;
    await env.call(env.owner, "PUT", `/api/agents/${worker}/config`, { credentialId: null, model: null });
    try {
      plan = [tool("prepare_self_runtime", { agentId: "ceo", ...config() })];
      // Extra/unrelated fields and another agent cannot pass the literal-bound tool schema.
      expect((await send("agent", worker, id)).actions[0].status).toBe("failed");
      plan = [tool("prepare_self_runtime", { agentId: worker, credentialId: key, model: "claude-haiku-5-5", effort: "medium" })];
      const view = await send("agent", worker, id);
      const action = view.actions.find((a: any) => a.status === "pending");
      expect(view.run.status).toBe("waiting_approval");
      expect((await env.call(env.owner, "GET", `/api/agents/${worker}`)).body.config.credentialId).toBeNull();
      await call("agent", worker, "POST", `/${id}/actions/${action.id}`, { approve: true });
      await env.ownerChat.idle();
      expect((await env.call(env.owner, "GET", `/api/agents/${worker}`)).body.config).toMatchObject(before);
      plan = [tool("create_task", { title: "Prepared self work", assigneeAgentId: "me" })];
      const result = await send("agent", worker, id);
      expect(result.actions.find((a: any) => a.name === "create_task").result.task.assigneeAgentId).toBe(worker);
    } finally { await env.call(env.owner, "PUT", `/api/agents/${worker}/config`, before); }
  });
  it("requires important-action approval scoped to this chat, preserves receipts and never treats confirmation as an authority grant", async () => {
    const id = await create("agent", worker);
    const task = (await env.call(env.owner, "POST", "/api/tasks", { title: "Owner's ops task", assigneeAgentId: "lead-ops" })).body.task;
    plan = [tool("task_action", { id: task.id, action: "cancel" })];
    const view = await send("agent", worker, id);
    expect(view.run.status).toBe("waiting_approval");
    const action = view.actions[0]; expect(action.status).toBe("pending");
    expect((await call("agent", "lead-eng", "POST", `/${id}/actions/${action.id}`, { approve: true })).status).toBe(404);
    expect((await call("agent", worker, "POST", `/${id}/actions/${action.id}`, { approve: true })).status).toBe(200);
    await env.ownerChat.idle();
    expect((await call("agent", worker, "GET", `/${id}`)).body.actions[0].status).toBe("failed");
    expect((await env.call(env.owner, "GET", `/api/tasks/${task.id}`)).body.status).not.toBe("cancelled");
  });
  it("animal persona proposes work to the CEO with approval, then compact, archive, restore and delete", async () => {
    const index = (await call("object", cat, "GET")).body;
    expect(index.profile.template).toContain("cat companion");
    expect(index.profile.instructions).toContain("Enjoy coffee discussions.");
    expect(index.profile.instructions).toContain("Be curious.");
    const id = await create("object", cat);
    plan = [tool("create_task", { title: "Cat direct task" }), tool("assign_to_ceo", { title: "Cat follow-up", description: "Restock the coffee beans." })];
    const next = await send("object", cat, id);
    expect(next.actions[0].status).toBe("failed");
    expect(next.run.status).toBe("waiting_approval");
    const a = next.actions.find((a: any) => a.status === "pending");
    expect((await call("object", cat, "POST", `/${id}/actions/${a.id}`, { approve: true })).status).toBe(200);
    await env.ownerChat.idle();
    const task = (await call("object", cat, "GET", `/${id}`)).body.actions.find((x: any) => x.id === a.id).result.task;
    expect((await env.call(env.owner, "GET", `/api/tasks/${task.id}`)).body).toMatchObject({ assigneeAgentId: "ceo", createdBy: "human:owner" });
    expect((await call("object", cat, "POST", `/${id}/compact`, { requestId: crypto.randomUUID() })).status).toBe(200); await env.ownerChat.idle();
    expect((await call("object", cat, "GET", `/${id}`)).body.chat.usage.compactions).toBe(1);
    expect((await call("object", cat, "PUT", `/${id}/archive`, { archived: true })).status).toBe(200);
    expect((await call("object", cat, "GET", "?archived=true")).body.chats.some((c: any) => c.id === id)).toBe(true);
    expect((await call("object", cat, "PUT", `/${id}/archive`, { archived: false })).status).toBe(200);
    expect((await call("object", cat, "DELETE", `/${id}`)).status).toBe(200);
    expect((await env.call(env.owner, "GET", `/api/tasks/${task.id}`)).body.title).toBe("Cat follow-up");
  });
  it("filters department keys, rechecks their scope at send and leaves runtime settings unchanged", async () => {
    const opsKey = (await env.call(env.owner, "POST", "/api/credentials", { name: "Ops key", apiKey: "sk-test-small-ops", departments: ["ops"] })).body.id;
    expect((await call("agent", worker, "GET")).body.credentials.some((c: any) => c.id === opsKey)).toBe(false);
    expect((await call("agent", worker, "POST", "", { ...config(), credentialId: opsKey })).status).toBe(403);
    const engKey = (await env.call(env.owner, "POST", "/api/credentials", { name: "Eng chat key", apiKey: "sk-test-small-eng", departments: ["eng"] })).body.id;
    const before = (await env.call(env.owner, "GET", `/api/agents/${worker}`)).body.config;
    const chat = (await call("agent", worker, "POST", "", { ...config(), credentialId: engKey })).body.id;
    expect((await env.call(env.owner, "GET", `/api/agents/${worker}`)).body.config).toEqual(before);
    await env.db.query("UPDATE credentials SET departments=ARRAY['ops']::text[] WHERE id=$1", [engKey]);
    expect((await call("agent", worker, "POST", `/${chat}/messages`, { requestId: crypto.randomUUID(), text: "Recheck scope" })).status).toBe(403);
  });
  it("stable object IDs survive rename/reorder, duplication gets fresh ID, missing subjects preserve history but reject new work", async () => {
    const id = await create("object", dog); await send("object", dog, id);
    let w = structuredClone((await env.call(env.owner, "GET", "/api/world")).body.world);
    w.objects.reverse(); w.objects.find((o: any) => o.id === dog).label = "New dog name";
    expect((await setWorld(w)).status).toBe(200);
    expect((await call("object", dog, "GET")).body.profile.name).toBe("New dog name");
    expect((await call("object", dog, "GET", `/${id}`)).body.messages).toHaveLength(2);
    w.objects.push({ ...w.objects[0] }); expect((await setWorld(w)).status).toBe(400);
    delete w.objects.at(-1).id; const saved = await setWorld(w); expect(saved.status).toBe(200);
    expect(saved.body.world.objects.at(-1).id).not.toBe(dog);
    w = saved.body.world; w.objects = w.objects.filter((o: any) => o.id !== dog); expect((await setWorld(w)).status).toBe(200);
    expect((await call("object", dog, "POST", `/${id}/messages`, { requestId: crypto.randomUUID(), text: "Where are you?" })).status).toBe(404);
    expect((await call("object", dog, "GET", `/${id}`)).body.messages).toHaveLength(2);
    const agentChat = await create("agent", "lead-eng"); await send("agent", "lead-eng", agentChat);
    await env.db.query("UPDATE agents SET lifecycle_state='retired' WHERE id='lead-eng'");
    expect((await call("agent", "lead-eng", "POST", `/${agentChat}/messages`, { requestId: crypto.randomUUID(), text: "Retired" })).status).toBe(409);
    expect((await call("agent", "lead-eng", "GET", `/${agentChat}`)).status).toBe(200);
    await env.db.query("UPDATE agents SET lifecycle_state='active' WHERE id='lead-eng'");
  });
  it("migrates legacy world objects and owner history once, preserving supplied object IDs and stale revision protection", async () => {
    const ownerChat = (await env.call(env.owner, "POST", "/api/owner-chats", config())).body.id;
    await env.call(env.owner, "POST", `/api/owner-chats/${ownerChat}/messages`, { requestId: crypto.randomUUID(), text: "Legacy owner history" }); await env.ownerChat.idle();
    await env.db.query("DELETE FROM owner_chats WHERE subject_type<>'owner'");
    await env.db.query("ALTER TABLE owner_chats DROP COLUMN subject_type CASCADE, DROP COLUMN subject_id CASCADE; DELETE FROM schema_migrations WHERE version>=14");
    const old = (await env.db.query("SELECT config,config_revision FROM organizations WHERE id=$1", [env.instance.defaultOrgId])).rows[0];
    const doc = structuredClone(old.config); delete doc.world.objects[0].id;
    const supplied = doc.world.objects[1].id;
    await env.db.query("UPDATE organizations SET config=$2 WHERE id=$1", [env.instance.defaultOrgId, JSON.stringify(doc)]);
    await migrate(env.db);
    const next = (await env.db.query("SELECT config,config_revision FROM organizations WHERE id=$1", [env.instance.defaultOrgId])).rows[0];
    expect(next.config.world.objects[0].id).toMatch(/^obj-/);
    expect(next.config.world.objects[1].id).toBe(supplied);
    expect(next.config_revision).toBe(old.config_revision + 1);
    expect((await env.call(env.owner, "GET", `/api/owner-chats/${ownerChat}`)).body.messages[0].text).toBe("Legacy owner history");
    expect((await env.call(env.owner, "PUT", "/api/world", { revision: old.config_revision, world: doc.world })).status).toBe(409);
    await migrate(env.db);
    expect((await env.db.query("SELECT config,config_revision FROM organizations WHERE id=$1", [env.instance.defaultOrgId])).rows[0]).toEqual(next);
  });
  it("provides templates for people, managers, cat, dog, robot and furniture", () => {
    const templates = [chatInstructionTemplate(), chatInstructionTemplate("person", "store-manager"), chatInstructionTemplate("cat"), chatInstructionTemplate("dog"), chatInstructionTemplate("robot"), chatInstructionTemplate("object", "desk", "static")];
    expect(new Set(templates).size).toBe(6);
  });
});
