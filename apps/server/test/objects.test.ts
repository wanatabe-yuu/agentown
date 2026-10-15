import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { objectState } from "@agentown/core/world";
import { setup } from "./helpers.ts";
import { emptyUsage, type ChatModel, type Message, type ModelInput } from "../src/chat/types.ts";

let env: Awaited<ReturnType<typeof setup>>;
let key: string, worker: string, cat: string, machine: string;
let plan: Message[] = [];
let inputs: ModelInput[] = [];
const fake: ChatModel = {
  async info() { return { contextWindow: 100000, maxOutputTokens: 8000, nativeCompaction: false, efforts: ["medium"] }; },
  async count(i) { return { tokens: 1000 + i.messages.length * 50, mode: "estimated" }; },
  async complete(i) { inputs.push({ ...i, messages: structuredClone(i.messages) }); return { message: plan.shift() ?? { role: "assistant", text: "Okay." }, usage: { ...emptyUsage(), requests: 1 } }; },
  async compact() { return { message: { role: "user", text: "Summary" }, usage: emptyUsage() }; },
};
const config = () => ({ credentialId: key, model: "claude-haiku-5-5", effort: "medium", approvalMode: "important" });
const tool = (name: string, args: Record<string, unknown>): Message => ({ role: "assistant", text: "", calls: [{ id: crypto.randomUUID(), name, args }] });
const act = (id: string, body: unknown, token = env.owner) => env.call(token, "POST", `/api/objects/${id}/actions`, body);

beforeAll(async () => {
  env = await setup(() => fake);
  key = (await env.call(env.owner, "POST", "/api/credentials", { name: "Key", apiKey: "sk-test-small-objects" })).body.id;
  worker = (await env.call(env.owner, "POST", "/api/agents", { templateId: "engineer-v1", displayName: "Kai", reportsToAgentId: "lead-eng" })).body.agent.id;
  for (const agent of ["ceo", worker]) await env.call(env.owner, "PUT", `/api/agents/${agent}/config`, { credentialId: key, model: "claude-haiku-5-5", effort: "medium" });
  const old = (await env.call(env.owner, "GET", "/api/world")).body;
  const r = await env.call(env.owner, "PUT", "/api/world", { revision: old.revision, world: {
    floors: [{ id: "g", name: "Ground", rooms: [
      { id: "cafe", name: "Café", area: { x: 0, z: 0, w: 8, d: 8 } },
      { id: "ops-room", name: "Ops", department: "ops", area: { x: 8, z: 0, w: 8, d: 8 } },
    ] }],
    kinds: {
      cat: { name: "Cat", category: "character", look: { character: "cat" }, chat: {}, behaviors: [{ type: "roam" }], access: "all",
        states: [{ id: "wander", name: "Wandering" }, { id: "nap", name: "Napping", pose: "sleep", auto: true, behaviors: [] }, { id: "purr", name: "Purring", pose: "happy", behaviors: [] }],
        actions: [{ id: "pet", name: "Pet", state: "purr", seconds: 30, gesture: "pet" }] },
      machine: { name: "Machine", category: "dynamic", look: { parts: [{ shape: "box" }] },
        states: [{ id: "idle", name: "Idle" }, { id: "brewing", name: "Brewing" }], actions: [{ id: "brew", name: "Brew", state: "brewing" }] },
    },
    objects: [{ kind: "cat", room: "cafe", at: [2, 2], label: "Bean" }, { kind: "machine", room: "ops-room", at: [2, 2], label: "Brewer" }],
  } });
  expect(r.status).toBe(200);
  [cat, machine] = r.body.world.objects.map((o: any) => o.id);
});
beforeEach(() => { plan = []; inputs = []; });
afterAll(async () => env?.close());

describe("what objects are doing", () => {
  it("the owner asks an agent to pet the cat; everyone sees it in the snapshot and the event stream", async () => {
    const r = await act(cat, { action: "pet", agentId: worker });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ objectId: cat, action: "pet", state: "purr", by: { type: "agent", id: worker } });
    // 30 s of petting plus the walk over.
    expect(Date.parse(r.body.until) - Date.now()).toBeGreaterThan(45_000);
    const snap = (await env.call(env.owner, "GET", "/api/office/snapshot")).body;
    expect(snap.objectStates).toContainEqual(expect.objectContaining({ objectId: cat, state: "purr" }));
    const events = await env.service.eventsAfter({ kind: "agent", id: "ceo" }, 0, 10000);
    expect(events.some((e) => e.type === "org.object" && e.payload.objectId === cat)).toBe(true);
  });
  it("an agent acts only for itself and only on objects it can reach", async () => {
    expect((await act(cat, { action: "pet" }, env.token(worker))).status).toBe(200);
    expect((await act(machine, { action: "brew" }, env.token(worker))).status).toBe(403);
    expect((await act(cat, { action: "pet", agentId: "ceo" }, env.token(worker))).status).toBe(403);
    expect((await act(cat, { action: "fly" })).status).toBe(400);
    expect((await act("obj-missing", { action: "pet" })).status).toBe(404);
  });
  it("objects change only their own state from their chat; agents interact from theirs", async () => {
    const catChat = (await env.call(env.owner, "POST", `/api/entity-chats/object/${cat}`, config())).body.id;
    plan = [tool("set_state", { state: "nap" })];
    await env.call(env.owner, "POST", `/api/entity-chats/object/${cat}/${catChat}/messages`, { requestId: crypto.randomUUID(), text: "Take a nap" });
    await env.ownerChat.idle();
    expect(inputs[0]!.tools.map((t) => t.name)).toEqual(["look_around", "set_state", "assign_to_ceo"]);
    expect((await env.call(env.owner, "GET", "/api/office/snapshot")).body.objectStates).toContainEqual(expect.objectContaining({ objectId: cat, state: "nap", by: { type: "object", id: cat } }));
    const kaiChat = (await env.call(env.owner, "POST", `/api/entity-chats/agent/${worker}`, config())).body.id;
    plan = [tool("interact", { objectId: cat, action: "pet" })];
    await env.call(env.owner, "POST", `/api/entity-chats/agent/${worker}/${kaiChat}/messages`, { requestId: crypto.randomUUID(), text: "Go pet Bean" });
    await env.ownerChat.idle();
    const view = (await env.call(env.owner, "GET", `/api/entity-chats/agent/${worker}/${kaiChat}`)).body;
    expect(view.actions[0]).toMatchObject({ name: "interact", status: "applied" });
  });
  it("an object's own rhythm is the same for every viewer, and an action wins while it lasts", () => {
    const kind = { states: [{ id: "wander", name: "W", auto: false }, { id: "nap", name: "N", auto: true }] };
    const seen = new Set(Array.from({ length: 400 }, (_, i) => objectState(kind, "obj-cat", i * 5000)!.id));
    expect(seen).toEqual(new Set(["wander", "nap"]));
    expect(objectState(kind, "obj-cat", 1234)!.id).toBe(objectState(kind, "obj-cat", 1234)!.id);
    expect(objectState(kind, "obj-cat", 1000, { state: "nap", until: 2000 })!.id).toBe("nap");
    expect(objectState({ states: [] }, "x", 0)).toBeNull();
  });
});

describe("the system chat asks others", () => {
  it("relays to an agent's own chat; the reply shows under the agent's name and both histories link", async () => {
    const id = (await env.call(env.owner, "POST", "/api/owner-chats", config())).body.id;
    plan = [tool("ask", { type: "agent", id: worker, message: "Please pet Bean" }), { role: "assistant", text: "Bean is purring now." }, { role: "assistant", text: "Kai took care of it." }];
    await env.call(env.owner, "POST", `/api/owner-chats/${id}/messages`, { requestId: crypto.randomUUID(), text: "Can someone pet the cat?" });
    await env.ownerChat.idle();
    const view = (await env.call(env.owner, "GET", `/api/owner-chats/${id}`)).body;
    expect(view.messages).toContainEqual(expect.objectContaining({ role: "assistant", author_type: "agent", author_id: worker, text: "Bean is purring now." }));
    expect(view.actions[0]).toMatchObject({ name: "ask", status: "applied" });
    const kai = (await env.call(env.owner, "GET", `/api/entity-chats/agent/${worker}`)).body;
    expect(kai.refs.some((r: any) => r.chatId === id && r.subject.type === "owner")).toBe(true);
    const theirs = (await env.call(env.owner, "GET", `/api/entity-chats/agent/${worker}/${view.actions[0].result.chatId}`)).body;
    expect(theirs.messages.map((m: any) => m.text)).toContain("[From the owner's system chat] Please pet Bean");
  });
  it("links any chat that names an agent or object to their history", async () => {
    const id = (await env.call(env.owner, "POST", "/api/owner-chats", config())).body.id;
    await env.call(env.owner, "POST", `/api/owner-chats/${id}/messages`, { requestId: crypto.randomUUID(), text: "How is bean doing today?" });
    await env.ownerChat.idle();
    expect((await env.call(env.owner, "GET", `/api/entity-chats/object/${cat}`)).body.refs.some((r: any) => r.chatId === id)).toBe(true);
    expect((await env.call(env.owner, "GET", `/api/entity-chats/agent/${worker}`)).body.refs.some((r: any) => r.chatId === id)).toBe(false);
  });
});
