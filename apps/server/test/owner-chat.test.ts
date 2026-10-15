import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";
import { emptyUsage, type ChatModel, type Message, type ModelInput } from "../src/chat/types.ts";
import { OwnerChat } from "../src/owner-chat.ts";
import { ModelError } from "../src/chat/provider.ts";
import { patchDocument } from "../src/chat/tools.ts";

let env: Awaited<ReturnType<typeof setup>>;
let key: string;
let viewer: string;
let ownerId: string;
let plan: Array<Message | Error | ((i: ModelInput) => Promise<Message>)> = [];
let inputs: ModelInput[] = [];
let countLarge = false;
let compactFailure = false;
let truncated = false;
const usage = () => ({ ...emptyUsage(), inputTokens: 100, outputTokens: 25, cachedTokens: 20, requests: 1 });
const fake: ChatModel = {
  async info() { return { contextWindow: 100000, maxOutputTokens: 8000, nativeCompaction: true, efforts: ["low", "medium", "high"] }; },
  async count(i) { return { tokens: countLarge && i.messages.some(m => m.text.includes("large history")) ? 50000 : 1200 + i.messages.length * 50, mode: "api" }; },
  async complete(i) {
    inputs.push({ ...i, messages: structuredClone(i.messages) });
    const next = plan.shift() ?? { role: "assistant", text: "Done." };
    if (next instanceof Error) throw next;
    const message = typeof next === "function" ? await next(i) : next;
    if (message.text) i.onText?.(message.text);
    return { message, usage: usage(), truncated };
  },
  async compact() {
    if (compactFailure) throw new ModelError("Summary failed. History preserved.");
    return { message: { role: "assistant", text: "Summary: retain the current request and all completed action IDs.", native: [{ type: "compaction", content: "Summary: retain the current request and all completed action IDs.", signature: "test-signature" }] }, usage: usage() };
  },
};
const call = (method: string, path: string, body?: unknown, token?: string) => env.call(token ?? env.owner, method, `/api/owner-chats${path}`, body);
const config = (extra = {}) => ({ credentialId: key, model: "claude-haiku-5-5", effort: "medium", contextLimit: 64000, maxOutputTokens: 4096, maxTurns: 20, approvalMode: "important", ...extra });
const create = async (extra = {}) => {
  const res = await call("POST", "", config(extra)); expect(res.status).toBe(201); return res.body.id as string;
};
const send = async (id: string, text = "Inspect my world", requestId = crypto.randomUUID()) => {
  const res = await call("POST", `/${id}/messages`, { requestId, text }); expect(res.status).toBe(200); await env.ownerChat.idle(); return (await call("GET", `/${id}`)).body;
};
const tool = (name: string, args: Record<string, unknown>, id: string = crypto.randomUUID()): Message => ({ role: "assistant", text: "Working on your request.", calls: [{ id, name, args }] });

beforeAll(async () => {
  env = await setup(() => fake);
  key = (await env.call(env.owner, "POST", "/api/credentials", { name: "Owner test key", apiKey: "sk-test-small-owner" })).body.id;
  viewer = (await env.call(env.owner, "POST", "/api/users", { displayName: "Chat viewer", roleId: "admin" })).body.token;
  ownerId = (await env.instance.authenticate(env.owner))!.id;
});
beforeEach(() => { plan = []; inputs = []; countLarge = false; compactFailure = false; truncated = false; });
afterAll(async () => env?.close());

describe("owner harness chat", () => {
  it("keeps history but removes signed provider context after a custom connection revision changes", async () => {
    const credential = (await env.call(env.owner, "POST", "/api/credentials", { name: "Gateway context", provider: "custom", protocol: "anthropic", baseUrl: "https://gateway.example.com/v1", apiKey: "sk-test-small-gateway" })).body;
    const id = await create({ credentialId: credential.id }); await send(id);
    await call("POST", `/${id}/compact`, { requestId: crypto.randomUUID() }); await env.ownerChat.idle();
    const before = (await call("GET", `/${id}`)).body.messages;
    expect((await env.db.query("SELECT context FROM owner_chats WHERE id=$1", [id])).rows[0].context.some((m: Message) => m.native?.some((b: any) => b.type === "compaction"))).toBe(true);
    expect((await env.call(env.owner, "PUT", `/api/credentials/${credential.id}/connection`, { revision: credential.revision, protocol: "anthropic", baseUrl: "https://gateway.example.com/v1", authHeader: { name: "x-gateway-key", scheme: "raw" } })).status).toBe(200);
    const data = await send(id, "Continue with the changed gateway");
    expect(data.run.status).toBe("succeeded");
    expect(inputs.at(-1)!.messages.every(m => !m.native && !m.reasoning)).toBe(true);
    expect(data.messages.slice(0, before.length)).toEqual(before);
  });
  it("archives, reads, restores and deletes history with its receipts without undoing world changes", async () => {
    const id = await create();
    plan = [tool("create_task", { title: "Keep task after deleting chat" })];
    const original = await send(id);
    expect(original.actions).toHaveLength(1);
    expect((await call("PUT", `/${id}/archive`, { archived: true })).status).toBe(200);
    expect((await call("GET", "")).body.chats.some((c: any) => c.id === id)).toBe(false);
    expect((await call("GET", "?archived=true")).body.chats.some((c: any) => c.id === id && c.archivedAt)).toBe(true);
    expect((await call("GET", `/${id}`)).body.messages).toEqual(original.messages);
    expect((await call("POST", `/${id}/messages`, { requestId: crypto.randomUUID(), text: "Blocked" })).status).toBe(409);
    expect((await call("POST", `/${id}/compact`, { requestId: crypto.randomUUID() })).status).toBe(409);
    expect((await call("PUT", `/${id}/config`, config())).status).toBe(409);
    expect((await call("PUT", `/${id}/archive`, { archived: false })).status).toBe(200);
    expect((await call("GET", "")).body.chats.some((c: any) => c.id === id && c.archivedAt === null)).toBe(true);
    await send(id, "Continue restored chat");
    expect((await call("DELETE", `/${id}`)).status).toBe(200);
    expect((await call("GET", `/${id}`)).status).toBe(404);
    expect((await call("DELETE", `/${id}`)).status).toBe(404);
    expect((await env.db.query("SELECT count(*)::int n FROM owner_chat_messages WHERE chat_id=$1", [id])).rows[0].n).toBe(0);
    expect((await env.db.query("SELECT count(*)::int n FROM owner_chat_runs WHERE chat_id=$1", [id])).rows[0].n).toBe(0);
    expect((await env.db.query("SELECT count(*)::int n FROM owner_chat_actions WHERE run_id=$1", [original.run.id])).rows[0].n).toBe(0);
    expect((await env.db.query("SELECT count(*)::int n FROM tasks WHERE title='Keep task after deleting chat'")).rows[0].n).toBe(1);
  });
  it("denies lifecycle changes across users and worlds, including archived chats", async () => {
    const id = await create();
    await env.call(env.owner, "POST", "/api/admin/orgs", { id: "chat-lifecycle-other", name: "Other chat world", templateId: "company", owner: { userId: ownerId } });
    for (const archived of [false, true]) {
      await call("PUT", `/${id}/archive`, { archived });
      expect((await call("PUT", `/${id}/archive`, { archived: !archived }, viewer)).status).toBe(403);
      expect((await call("DELETE", `/${id}`, undefined, viewer)).status).toBe(403);
      expect((await call("DELETE", `/${id}`, undefined, env.token("ceo"))).status).toBe(403);
      expect((await env.call(env.owner, "PUT", `/api/orgs/chat-lifecycle-other/owner-chats/${id}/archive`, { archived: !archived })).status).toBe(404);
      expect((await env.call(env.owner, "DELETE", `/api/orgs/chat-lifecycle-other/owner-chats/${id}`)).status).toBe(404);
    }
    expect((await call("GET", "?archived=invalid")).status).toBe(400);
  });
  it("refuses archive/delete while streaming or awaiting approval, and serializes against a new send", async () => {
    const id = await create();
    let entered!: () => void; const gate = new Promise<void>(r => { entered = r; });
    plan = [async i => { entered(); await new Promise<void>((_, reject) => i.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); return { role: "assistant", text: "never" }; }];
    await call("POST", `/${id}/messages`, { requestId: crypto.randomUUID(), text: "Wait" }); await gate;
    for (const action of ["archive", "delete"]) expect((await call(action === "delete" ? "DELETE" : "PUT", `/${id}${action === "delete" ? "" : "/archive"}`, action === "delete" ? undefined : { archived: true })).status).toBe(409);
    await call("POST", `/${id}/stop`);
    plan = [tool("agent_action", { id: "ceo", action: "stop" })]; await send(id);
    expect((await call("DELETE", `/${id}`)).status).toBe(409);
    expect((await call("PUT", `/${id}/archive`, { archived: true })).status).toBe(409);
    await call("POST", `/${id}/stop`);
    const race = await Promise.all([call("PUT", `/${id}/archive`, { archived: true }), call("POST", `/${id}/messages`, { requestId: crypto.randomUUID(), text: "Racing send" })]);
    expect(race.map(r => r.status).sort()).toEqual([200, 409]);
    await env.ownerChat.idle();
    const view = (await call("GET", `/${id}`)).body;
    expect(!!view.chat.archivedAt && ["running", "waiting_approval"].includes(view.run.status)).toBe(false);
  });
  it("is private to the live owner, rejects agents and privileged members", async () => {
    const id = await create();
    for (const token of [viewer, env.token("ceo")]) {
      expect((await call("GET", "", undefined, token)).status).toBe(403);
      expect((await call("GET", `/${id}`, undefined, token)).status).toBe(403);
      expect((await call("POST", "", config(), token)).status).toBe(403);
    }
    expect((await env.call(env.token("ceo"), "GET", "/api/owner-chats")).status).toBe(403);
  });
  it("keeps chats, tools and credentials in one organization", async () => {
    await env.call(env.owner, "POST", "/api/admin/orgs", { id: "chat-other", name: "Other world", templateId: "company", owner: { userId: ownerId } });
    const id = await create();
    expect((await env.call(env.owner, "GET", `/api/orgs/chat-other/owner-chats/${id}`)).status).toBe(404);
    expect((await env.call(env.owner, "POST", "/api/orgs/chat-other/owner-chats", config())).status).toBe(404);
    const other = (await env.instance.org("chat-other").then(v => v.listAgents({ kind: "human", id: ownerId, owner: true })))[0]!;
    plan = [tool("update_agent", { id: other.id, change: { displayName: "Wrong world" } })];
    const data = await send(id);
    expect(data.actions[0].status).toBe("failed");
    expect((await env.db.query("SELECT display_name FROM agents WHERE id=$1", [other.id])).rows[0].display_name).not.toBe("Wrong world");
  });
  it("uses saved key/model settings and leaves every agent configuration intact", async () => {
    const before = (await env.db.query("SELECT id,credential_id,model,effort FROM agents ORDER BY id")).rows;
    const listing = (await call("GET", "")).body;
    expect(listing.credentials[0].apiKey).toBeUndefined();
    expect(JSON.stringify(listing)).not.toContain("sk-test-small-owner");
    const id = await create(); const data = await send(id, "Hello owner chat");
    expect(data.run.status).toBe("succeeded"); expect(inputs[0]!.config.effort).toBe("medium");
    expect((await env.db.query("SELECT id,credential_id,model,effort FROM agents ORDER BY id")).rows).toEqual(before);
  });
  it("creates work once, persists tool receipts and deduplicates message retries", async () => {
    const id = await create(); const req = crypto.randomUUID();
    plan = [tool("create_task", { title: "Owner once" })];
    const first = await send(id, "Create one task", req);
    expect(first.actions[0].status).toBe("applied");
    await send(id, "Create one task", req);
    expect((await env.db.query("SELECT count(*)::int n FROM tasks WHERE title='Owner once'")).rows[0].n).toBe(1);
    expect((await env.db.query("SELECT spec FROM tasks WHERE title='Owner once'")).rows[0].spec.kind).toBe("prompt");
    expect((await call("GET", `/${id}`)).body.messages.filter((m: any) => m.role === "user")).toHaveLength(1);
    expect(inputs[1]!.messages.at(-1)?.role).toBe("tool");
  });
  it("parks important changes for approval, rejects once, and prevents automatic replay", async () => {
    const id = await create();
    plan = [tool("agent_action", { id: "ceo", action: "stop" })];
    const pending = await send(id);
    expect(pending.run.status).toBe("waiting_approval");
    expect(pending.actions[0].status).toBe("pending");
    expect((await env.service.getAgent({ kind: "human", id: ownerId, owner: true }, "ceo")).desiredRuntime).toBe("running");
    const actionId = pending.actions[0].id;
    expect((await call("POST", `/${id}/actions/${actionId}`, { approve: false })).status).toBe(200);
    await env.ownerChat.idle();
    expect((await call("GET", `/${id}`)).body.actions[0].status).toBe("rejected");
    await call("POST", `/${id}/actions/${actionId}`, { approve: true }); await env.ownerChat.idle();
    expect((await env.service.getAgent({ kind: "human", id: ownerId, owner: true }, "ceo")).desiredRuntime).toBe("running");
  });
  it("approval executes the exact proposal only once, then continues the response", async () => {
    const id = await create({ approvalMode: "all" });
    plan = [tool("update_agent", { id: "po", change: { displayName: "Owner renamed" } })];
    const pending = await send(id);
    const path = `/${id}/actions/${pending.actions[0].id}`;
    await Promise.all([call("POST", path, { approve: true }), call("POST", path, { approve: true })]); await env.ownerChat.idle();
    const data = (await call("GET", `/${id}`)).body;
    expect(data.run.status).toBe("succeeded"); expect(data.actions[0].status).toBe("applied");
    expect((await env.db.query("SELECT display_name FROM agents WHERE id='po'")).rows[0].display_name).toBe("Owner renamed");
  });
  it("validates model and limits and prevents setting changes while approval is pending", async () => {
    expect((await call("POST", "", config({ model: "unavailable" }))).status).toBe(400);
    expect((await call("POST", "", config({ contextLimit: 8192, maxOutputTokens: 4096 }))).status).toBe(400);
    const id = await create(); plan = [tool("retire_agent", { id: "ceo" })]; await send(id);
    expect((await call("PUT", `/${id}/config`, config({ maxTurns: 2 }))).status).toBe(409);
    await call("POST", `/${id}/stop`);
    expect((await call("GET", `/${id}`)).body.run.status).toBe("cancelled");
    expect((await call("PUT", `/${id}/config`, config({ maxTurns: 2 }))).status).toBe(200);
  });
  it("rejects concurrent sends and safely stops streamed output", async () => {
    const id = await create();
    let entered!: () => void; const gate = new Promise<void>(r => { entered = r; });
    plan = [async i => { i.onText?.("Partial reply"); entered(); await new Promise<void>((_, reject) => i.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); return { role: "assistant", text: "never" }; }];
    await call("POST", `/${id}/messages`, { requestId: crypto.randomUUID(), text: "Wait" }); await gate;
    expect((await call("POST", `/${id}/messages`, { requestId: crypto.randomUUID(), text: "Duplicate" })).status).toBe(409);
    expect((await call("POST", `/${id}/stop`)).status).toBe(200);
    const data = (await call("GET", `/${id}`)).body;
    expect(data.run.status).toBe("cancelled"); expect(data.messages.at(-1).partial).toBe(true); expect(data.messages.at(-1).text).toContain("Partial reply");
  });
  it("rechecks owner rights before approved writes", async () => {
    const id = await create(); plan = [tool("agent_action", { id: "ceo", action: "stop" })]; const data = await send(id);
    await env.db.query("UPDATE org_members SET is_owner=false WHERE user_id=$1 AND org_id='agentown'", [ownerId]);
    try { expect((await call("POST", `/${id}/actions/${data.actions[0].id}`, { approve: true })).status).toBe(403); }
    finally { await env.db.query("UPDATE org_members SET is_owner=true WHERE user_id=$1 AND org_id='agentown'", [ownerId]); }
    await call("POST", `/${id}/stop`);
  });
  it("rechecks account rights during a running model response before tools execute", async () => {
    const id = await create();
    plan = [async () => { await env.db.query("UPDATE org_members SET disabled_at=now() WHERE user_id=$1 AND org_id='agentown'", [ownerId]); return tool("update_agent", { id: "po", change: { displayName: "Forbidden rename" } }); }];
    await send(id).catch(() => {});
    await env.db.query("UPDATE org_members SET disabled_at=NULL WHERE user_id=$1 AND org_id='agentown'", [ownerId]);
    expect((await call("GET", `/${id}`)).body.run.status).toBe("failed");
    expect((await env.db.query("SELECT display_name FROM agents WHERE id='po'")).rows[0].display_name).not.toBe("Forbidden rename");
  });
  it("automatically compacts without losing transcript or the next request", async () => {
    const id = await create(); await send(id, "large history old request"); countLarge = true;
    const data = await send(id, "Current exact owner instruction");
    expect(data.run.status).toBe("succeeded"); expect(data.chat.usage.compactions).toBe(1);
    expect(data.messages.filter((m: any) => m.role === "user").map((m: any) => m.text)).toEqual(["large history old request", "Current exact owner instruction"]);
    const context = (await env.db.query("SELECT context FROM owner_chats WHERE id=$1", [id])).rows[0].context;
    expect(context[0].native[0].signature).toBe("test-signature"); expect(context[1].text).toBe("Current exact owner instruction");
    expect(data.chat.usage.inputTokens).toBe(300); expect(data.chat.usage.outputTokens).toBe(75); expect(data.chat.countMode).toBe("api");
  });
  it("manual compact preserves history and failed compaction preserves model context", async () => {
    const id = await create(); await send(id, "Remember a fact");
    const before = (await env.db.query("SELECT context FROM owner_chats WHERE id=$1", [id])).rows[0].context;
    compactFailure = true;
    await call("POST", `/${id}/compact`, { requestId: crypto.randomUUID() }); await env.ownerChat.idle();
    expect((await call("GET", `/${id}`)).body.run.status).toBe("failed");
    expect((await env.db.query("SELECT context FROM owner_chats WHERE id=$1", [id])).rows[0].context).toEqual(before);
    compactFailure = false;
    await call("POST", `/${id}/compact`, { requestId: crypto.randomUUID() }); await env.ownerChat.idle();
    expect((await call("GET", `/${id}`)).body.messages.some((m: any) => m.text === "Remember a fact")).toBe(true);
    expect((await env.db.query("SELECT context FROM owner_chats WHERE id=$1", [id])).rows[0].context).toHaveLength(1);
  });
  it("does not execute unknown tools and bounds loops", async () => {
    const id = await create({ maxTurns: 1 }); plan = [tool("shell", { command: "do anything" })];
    const data = await send(id); expect(data.actions[0].status).toBe("failed"); expect(data.run.status).toBe("limited");
    expect(data.run.error).toBeNull();
    expect(data.messages.some((m: any) => m.role === "notice" && /Reached 1 steps/.test(m.text))).toBe(true);
  });
  it("stops a batch after five failed actions and continues with a valid context", async () => {
    const id = await create();
    plan = [{ role: "assistant", text: "Checking", calls: Array.from({ length: 12 }, (_, n) => ({ id: `bad-${n}`, name: "shell", args: { command: `invalid-${n}` } })) }];
    const view = await send(id);
    expect(view.run.status).toBe("limited"); expect(view.run.rounds).toBe(1);
    expect(view.actions).toHaveLength(5);
    const next = await send(id, "Explain the blocker");
    expect(next.run.status).toBe("succeeded");
    expect(next.actions).toHaveLength(5);
  });
  it("never replays interrupted writes after recovery", async () => {
    const id = await create(); const rid = "cr-recover-test", tid = "tool-interrupted";
    await env.db.query("UPDATE owner_chats SET context=$2 WHERE id=$1", [id, JSON.stringify([tool("update_agent", { id: "po", change: { displayName: "Never replay" } }, tid)])]);
    await env.db.query("INSERT INTO owner_chat_runs(id,chat_id,request_id,status) VALUES($1,$2,'recovery-test','running')", [rid, id]);
    await env.db.query("INSERT INTO owner_chat_actions(id,run_id,tool_id,name,args,status) VALUES('ca-recovery-test',$1,$2,'update_agent',$3,'applying')", [rid, tid, JSON.stringify({ id: "po", change: { displayName: "Never replay" } })]);
    const recovered = new OwnerChat(env.instance, [], () => fake); await recovered.recover();
    const data = (await call("GET", `/${id}`)).body;
    expect(data.run.status).toBe("failed"); expect(data.actions[0].status).toBe("uncertain");
    await send(id, "What happened?");
    expect((await env.db.query("SELECT display_name FROM agents WHERE id='po'")).rows[0].display_name).not.toBe("Never replay");
    expect(inputs[0]!.messages.some(m => m.role === "tool" && m.toolId === tid)).toBe(true);
  });
  it("preserves revision checks on approved world replacements", async () => {
    const current = (await env.call(env.owner, "GET", "/api/world")).body;
    const id = await create(); plan = [tool("replace_world", { revision: current.revision - 1, world: null })]; const pending = await send(id);
    await call("POST", `/${id}/actions/${pending.actions[0].id}`, { approve: true }); await env.ownerChat.idle();
    expect((await call("GET", `/${id}`)).body.actions[0].result.error).toMatch(/changed meanwhile/);
  });
  it("edits a validated world immediately and rejects unknown assets through the same service", async () => {
    const current = (await env.call(env.owner, "GET", "/api/world")).body;
    const world = { floors: [{ id: "main", name: "Main", rooms: [{ id: "lobby", name: "Lobby", area: { x: 0, z: 0, w: 10, d: 8 } }] }] };
    expect((await env.call(env.owner, "PUT", "/api/world", { revision: current.revision, world })).status).toBe(200);
    const id = await create(); let state = (await env.call(env.owner, "GET", "/api/world")).body;
    plan = [tool("patch_world", { revision: state.revision, operations: [{ op: "replace", path: "/floors/0/rooms/0/name", value: "Owner lobby" }] })];
    const edited = await send(id, "Rename lobby"); expect(edited.actions[0].status).toBe("applied");
    state = (await env.call(env.owner, "GET", "/api/world")).body; expect(state.world.floors[0].rooms[0].name).toBe("Owner lobby");
    plan = [tool("patch_world", { revision: state.revision, operations: [{ op: "add", path: "/floors/0/rooms/0/floorTexture", value: "another-world-asset" }] })];
    const rejected = await send(id, "Use invalid art"); expect(rejected.actions.at(-1).status).toBe("failed");
    expect((await env.call(env.owner, "GET", "/api/world")).body.world.floors[0].rooms[0].floorTexture).toBeUndefined();
  });
  it("does not execute truncated tool calls or duplicate provider call IDs", async () => {
    const id = await create(); truncated = true;
    plan = [tool("update_agent", { id: "po", change: { displayName: "Incomplete change" } })];
    let data = await send(id); expect(data.run.status).toBe("failed"); expect(data.actions).toHaveLength(0); expect(data.messages.at(-1).partial).toBe(true);
    truncated = false;
    const callMessage = tool("update_agent", { id: "po", change: { displayName: "Duplicate change" } }); callMessage.calls!.push(callMessage.calls![0]!); plan = [callMessage];
    data = await send(id); expect(data.actions).toHaveLength(0); expect(data.run.error).toMatch(/duplicate/);
    expect((await env.db.query("SELECT display_name FROM agents WHERE id='po'")).rows[0].display_name).not.toMatch(/Incomplete|Duplicate/);
  });
  it("cannot bypass the prompt-only task UI with a script tool argument", async () => {
    const id = await create(); plan = [tool("create_task", { title: "Hidden shell", spec: { kind: "script", command: "echo forbidden" } })];
    const data = await send(id); expect(data.actions[0].status).toBe("failed");
    expect((await env.db.query("SELECT count(*)::int n FROM tasks WHERE title='Hidden shell'")).rows[0].n).toBe(0);
  });
  it("resumes a committed approval after restart without replaying an applied action", async () => {
    const id = await create(); plan = [tool("agent_action", { id: "po", action: "restart" })];
    const pending = await send(id);
    await env.db.query("UPDATE owner_chat_actions SET status='approved' WHERE id=$1", [pending.actions[0].id]);
    await env.ownerChat.recover(); await env.ownerChat.idle();
    const after = (await call("GET", `/${id}`)).body;
    expect(after.actions[0].status).toBe("applied"); expect(after.run.status).toBe("succeeded");
    const generation = (await env.service.getRuntimeRow("po")).generation;
    await env.ownerChat.recover(); await env.ownerChat.idle();
    expect((await env.service.getRuntimeRow("po")).generation).toBe(generation);
  });
});

it("patches arrays without prototype mutation, silent creation or invalid offsets", () => {
  expect(patchDocument({ a: [1, 2] }, [{ op: "add", path: "/a/1", value: 3 }])).toEqual({ a: [1, 3, 2] });
  expect(() => patchDocument({}, [{ op: "add", path: "/__proto__/polluted", value: true }])).toThrow();
  expect(() => patchDocument({}, [{ op: "replace", path: "/missing", value: 1 }])).toThrow();
  expect(() => patchDocument({ a: [] }, [{ op: "add", path: "/a/3", value: 1 }])).toThrow();
});
