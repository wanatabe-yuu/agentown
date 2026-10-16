import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emptyUsage, type ChatModel, type Message, type ModelInput } from "../src/chat/types.ts";
import { setup } from "./helpers.ts";

// Computers wait for requests like agents: one at a time, exact or in words (their model uses their apps).
let env: Awaited<ReturnType<typeof setup>>;
let mcp: http.Server;
let pc: string, bare: string;
let inputs: ModelInput[] = [];
let plan: Message[] = [];
const fake: ChatModel = {
  async info() { return { contextWindow: 100000, maxOutputTokens: 8000, nativeCompaction: false, efforts: ["low", "medium"] }; },
  async count() { return { tokens: 100, mode: "estimated" }; },
  async complete(i) { inputs.push({ ...i, messages: structuredClone(i.messages) }); return { message: plan.shift() ?? { role: "assistant", text: "Done." }, usage: { ...emptyUsage(), requests: 1 } }; },
  async compact() { return { message: { role: "user", text: "summary" }, usage: emptyUsage() }; },
};
const call = (name: string, args: Record<string, unknown>): Message => ({ role: "assistant", text: "", calls: [{ id: crypto.randomUUID(), name, args }] });
const ask = (computer: string, body: unknown, token = env.owner) => env.call(token, "POST", `/api/computers/${computer}/requests`, body);

/** An MCP server with one slow-ish tool, so queued requests overlap if the queue is broken. */
function startMcp(): Promise<string> {
  mcp = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const m = JSON.parse(body);
      if (m.id === undefined) return res.writeHead(202).end();
      const result =
        m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" } }
        : m.method === "tools/list" ? { tools: [{ name: "echo", description: "Says it back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] }
        : { content: [{ type: "text", text: `echo: ${m.params.arguments.text}` }] };
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result })), m.method === "tools/call" ? 60 : 0);
    });
  });
  return new Promise((r) => mcp.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`)));
}

beforeAll(async () => {
  env = await setup(() => fake);
  const url = await startMcp();
  const key = (await env.call(env.owner, "POST", "/api/credentials", { name: "Key", apiKey: "sk-test-small-pc" })).body.id;
  expect((await env.call(env.owner, "PUT", "/api/agents/ceo/config", { credentialId: key, model: "claude-haiku-5-5", effort: "medium" })).status).toBe(200);
  const old = await env.call(env.owner, "GET", "/api/world");
  const r = await env.call(env.owner, "PUT", "/api/world", {
    revision: old.body.revision,
    world: {
      floors: [{ id: "ground", name: "Ground", rooms: [{ id: "office", name: "Office", area: { x: 0, z: 0, w: 10, d: 10 } }] }],
      kinds: {
        pc: { name: "PC", category: "static", look: { parts: [{ shape: "box" }] }, computer: { apps: ["mcp"], connectors: ["shop"] } },
        bare: { name: "Old PC", category: "static", look: { parts: [{ shape: "box" }] }, computer: { apps: ["mcp"] } },
      },
      objects: [{ kind: "pc", room: "office", at: [1, 1], label: "Front PC" }, { kind: "bare", room: "office", at: [3, 3] }],
      connectors: { shop: { name: "Shop", url, approval: "auto" } },
    },
  });
  expect(r.status).toBe(200);
  [pc, bare] = r.body.world.objects.map((o: { id: string }) => o.id);
  await env.settle();
});
afterAll(async () => {
  mcp?.close();
  await env?.close();
});
beforeEach(() => {
  inputs = [];
  plan = [];
});

describe("computers take requests", () => {
  it("exact requests run its apps; it only has the apps and connectors it was given", async () => {
    const tools = await ask(pc, { app: "mcp", action: "tools", connector: "shop" });
    expect(tools.status).toBe(200);
    expect(tools.body.result).toContain("echo");
    expect((await ask(pc, { app: "mcp", action: "call", connector: "shop", tool: "echo", args: { text: "hi" } })).body).toMatchObject({ status: "done", result: "echo: hi" });
    expect((await ask(bare, { app: "mcp", action: "tools", connector: "shop" })).status).toBe(400); // not attached to it
    expect((await ask(pc, { app: "stream", action: "play", url: "https://example.com/a.mp4" })).status).toBe(400); // no stream app
    const list = (await env.call(env.owner, "GET", `/api/computers/${pc}/requests`)).body.requests;
    expect(list.slice(0, 2).map((r: { status: string; requester: string }) => [r.status, r.requester])).toEqual([["done", "human:owner"], ["done", "human:owner"]]);
  });

  it("a request in words: its model does it with its apps as tools, and the requester gets the answer", async () => {
    plan = [call("mcp_call", { connector: "shop", tool: "echo", args: { text: "from the brain" } }), { role: "assistant", text: "The shop said: echo: from the brain" }];
    const r = await env.call(env.token("lead-eng"), "POST", "/api/tools/computer/invoke", { args: { computer: pc, request: { text: "Ask the shop to say something" } } });
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ status: "done", result: "The shop said: echo: from the brain" });
    expect(inputs[0]!.tools.map((t) => t.name).sort()).toEqual(["mcp_call", "mcp_tools", "show"]);
    expect(inputs[1]!.messages.at(-1)).toMatchObject({ role: "tool", text: "echo: from the brain" });
    expect((await env.call(env.owner, "GET", `/api/computers/${pc}/requests`)).body.requests[0].requester).toBe("agent:lead-eng");
  });

  it("requests from several people wait their turn: one at a time, never overlapping", async () => {
    const all = await Promise.all([1, 2, 3].map((n) => ask(pc, { app: "mcp", action: "call", connector: "shop", tool: "echo", args: { text: `n${n}` } })));
    expect(all.map((r) => r.body.status)).toEqual(["done", "done", "done"]);
    const { rows } = await env.db.query(
      "SELECT started_at, finished_at FROM computer_requests WHERE object_id=$1 AND input->'args'->>'text' IN ('n1','n2','n3') ORDER BY started_at",
      [pc],
    );
    for (let i = 1; i < rows.length; i++) expect(rows[i].started_at.getTime()).toBeGreaterThanOrEqual(rows[i - 1].finished_at.getTime());
  });

  it("people chat with a computer: what they ask goes to its queue through use_computer", async () => {
    const key = (await env.call(env.owner, "GET", "/api/credentials")).body.credentials[0].id;
    const chat = await env.call(env.owner, "POST", `/api/entity-chats/object/${pc}`, { credentialId: key, model: "claude-haiku-5-5", effort: "medium", approvalMode: "important" });
    expect(chat.status).toBe(201);
    plan = [
      call("use_computer", { request: "say hello through the shop" }),
      call("mcp_call", { connector: "shop", tool: "echo", args: { text: "hello" } }),
      { role: "assistant", text: "echo: hello" },
      { role: "assistant", text: "The shop said hello." },
    ];
    expect((await env.call(env.owner, "POST", `/api/entity-chats/object/${pc}/${chat.body.id}/messages`, { requestId: crypto.randomUUID(), text: "Can you greet via the shop?" })).status).toBe(200);
    await env.ownerChat.idle();
    expect(inputs[0]!.tools.map((t) => t.name)).toContain("use_computer");
    const last = (await env.call(env.owner, "GET", `/api/computers/${pc}/requests`)).body.requests[0];
    expect(last).toMatchObject({ requester: "human:owner", app: null, status: "done", result: "echo: hello" });
  });
});
