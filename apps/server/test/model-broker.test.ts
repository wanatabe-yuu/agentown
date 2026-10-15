import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";
import { registerProviderKey, redactProviderKeys, redactedBody } from "../src/key-redaction.ts";

let env: Awaited<ReturnType<typeof setup>>;
let base: string, credential: string, generation: number;
const KEY = "sk-test-small-BROKER-private-key-6789";
const seen: Array<{ path: string; headers: Record<string, unknown>; body: any }> = [];
const server = createServer((req, res) => {
  let raw = ""; req.on("data", c => { raw += c; }); req.on("end", () => {
    const body = JSON.parse(raw); seen.push({ path: req.url!, headers: req.headers, body });
    res.setHeader("x-provider-secret", KEY);
    if (body.fail) { res.statusCode = 401; res.end(JSON.stringify({ error: { message: KEY } })); return; }
    res.setHeader("content-type", body.stream ? "text/event-stream" : "application/json");
    const text = body.stream ? `data: ${JSON.stringify({ text: KEY, encoded: Buffer.from(KEY).toString("base64") })}\n\n` : JSON.stringify({ content: [{ type: "text", text: "Provider works" }], usage: { input_tokens: 3, output_tokens: 2 } });
    for (let i = 0; i < text.length; i += 3) res.write(text.slice(i, i + 3));
    res.end();
  });
});
beforeAll(async () => {
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  env = await setup();
  const created = await env.call(env.owner, "POST", "/api/credentials", { name: "Broker key", apiKey: KEY, provider: "custom", protocol: "anthropic", baseUrl: base });
  expect(created.status).toBe(201); credential = created.body.id;
  await env.call(env.owner, "PUT", "/api/agents/ceo/config", { credentialId: credential, model: "claude-haiku-5-5" });
  await env.settle(); await env.settle();
  generation = (await env.db.query("SELECT generation FROM agent_runtimes WHERE agent_id='ceo'")).rows[0].generation;
});
afterAll(async () => { await env.close(); await new Promise<void>(r => server.close(() => r())); });
const call = (extra: Record<string, unknown> = {}, token = env.token("ceo"), gen = generation, path = "anthropic/v1/messages") => env.app.inject({ method: "POST", url: `/api/runtime/llm/${path}`, headers: { authorization: `Bearer ${token}`, "x-agentown-generation": String(gen) }, payload: { model: "claude-haiku-5-5", messages: [{ role: "user", content: "Hi" }], max_tokens: 32, ...extra } });

describe("server-only provider credentials", () => {
  it("models work through the broker but the runtime and both public credential views never contain key values or fragments", async () => {
    const result = await call(); expect(result.statusCode).toBe(200); expect(result.json().content[0].text).toBe("Provider works");
    expect(seen.at(-1)!.headers["x-api-key"]).toBe(KEY); expect(seen.at(-1)!.headers.authorization).toBeUndefined();
    const runtime = await env.service.runtimeCredential("ceo"); expect((runtime.llm as any).apiKey).toBeUndefined();
    expect(JSON.stringify(runtime)).not.toContain(KEY);
    const pod = [...env.driver.pods.values()].find(p => p.agentId === "ceo")!;
    expect(pod.providerKey).toBeNull(); expect(pod.llmEnv.ANTHROPIC_API_KEY).toBeUndefined(); expect(pod.llmEnv.AGENTOWN_LLM_API_KEY).toBeUndefined();
    for (const token of [env.owner, env.token("ceo")]) {
      const response = await env.call(token, "GET", "/api/credentials"); expect(response.status).toBe(200);
      const c = response.body.credentials.find((k: any) => k.id === credential); expect(c.keyHint).toBe("Hidden");
      expect(JSON.stringify(response.body)).not.toContain(KEY); expect(c.keyHint).not.toContain("6789");
    }
  });
  it("refuses owners, other agents, old generations, wrong protocols/models and arbitrary provider endpoints", async () => {
    const count = seen.length;
    expect((await call({}, env.owner)).statusCode).not.toBe(200);
    expect((await env.app.inject({ method: "POST", url: "/api/orgs/agentown/runtime/llm/anthropic/v1/messages", headers: { authorization: `Bearer ${env.owner}`, "x-agentown-generation": String(generation) }, payload: { model: "claude-haiku-5-5" } })).statusCode).toBe(403);
    expect((await call({}, env.token("po"))).statusCode).not.toBe(200);
    expect((await call({}, env.token("ceo"), generation - 1)).statusCode).not.toBe(200);
    expect((await call({ model: "claude-opus-5-5" })).statusCode).toBe(403);
    expect((await call({}, env.token("ceo"), generation, "openai/v1/chat/completions")).statusCode).toBe(400);
    expect((await call({}, env.token("ceo"), generation, "anthropic/v1/keys")).statusCode).toBe(403);
    expect(seen.length).toBe(count);
  });
  it("concurrent claims never exhaust the database pool", async () => {
    expect((await env.db.query("SELECT applied_secret_rev FROM agent_runtimes WHERE agent_id='ceo'")).rows[0].applied_secret_rev).toMatch(/^broker-v1:/);
    // More claims than pool connections: each must finish inside its own transaction.
    const claims = await Promise.all(Array.from({ length: 12 }, () => env.call(env.token("ceo"), "POST", "/api/runs/claim", { generation })));
    expect(claims.map(c => c.status)).toEqual(Array(12).fill(204));
  }, 10_000);

  it("pins an active task's model and key while next-task settings change", async () => {
    const task = (await env.call(env.owner, "POST", "/api/tasks", { title: "Pinned runtime", assigneeAgentId: "ceo", spec: { kind: "prompt" } })).body.task;
    const claim = await env.call(env.token("ceo"), "POST", "/api/runs/claim", { generation });
    expect(claim.body.task.id).toBe(task.id);
    const next = (await env.call(env.owner, "POST", "/api/credentials", { name: "Next key", apiKey: "sk-test-wide-next-1234", provider: "custom", protocol: "anthropic", baseUrl: base })).body.id;
    try {
      await env.call(env.owner, "PUT", "/api/agents/ceo/config", { credentialId: next, model: "claude-sonnet-5-5" });
      expect((await call()).statusCode).toBe(200);
      expect(seen.at(-1)!.headers["x-api-key"]).toBe(KEY);
      expect((await call({ model: "claude-sonnet-5-5" })).statusCode).toBe(403);
      const resumed = await env.call(env.token("ceo"), "POST", "/api/runs/claim", { generation });
      expect(resumed.body.config.model).toBe("claude-haiku-5-5");
      expect(JSON.stringify(resumed.body)).not.toContain(KEY);
    } finally {
      await env.call(env.token("ceo"), "POST", `/api/runs/${claim.body.run.id}/complete`, { generation, outcome: "succeeded", summary: "Pinned settings retained" });
      await env.call(env.owner, "PUT", "/api/agents/ceo/config", { credentialId: credential, model: "claude-haiku-5-5" });
      await env.settle(); await env.settle();
      generation = (await env.db.query("SELECT generation FROM agent_runtimes WHERE agent_id='ceo'")).rows[0].generation;
    }
  });
  it("redacts provider echoes across stream chunks and suppresses secret response headers/error bodies", async () => {
    const response = await call({ stream: true }); expect(response.statusCode).toBe(200);
    expect(response.body).toContain("[redacted]"); expect(response.body).not.toContain(KEY); expect(response.body).not.toContain(Buffer.from(KEY).toString("base64"));
    expect(response.headers["x-provider-secret"]).toBeUndefined();
    const failed = await call({ fail: true }); expect(failed.statusCode).toBe(401); expect(failed.body).not.toContain(KEY);
    await call({ messages: [{ role: "user", content: KEY }] });
    expect(seen.at(-1)!.body.messages[0].content).toBe("[redacted]");
  });
  it("OpenAI-compatible runtimes also use server-held keys and receive redacted streams", async () => {
    const added = (await env.call(env.owner, "POST", "/api/credentials", { name: "Compatible broker", apiKey: KEY, provider: "custom", protocol: "openai", baseUrl: base })).body;
    await env.call(env.owner, "PUT", "/api/agents/po/config", { credentialId: added.id, model: "custom-chat" });
    await env.settle(); await env.settle();
    const gen = (await env.db.query("SELECT generation FROM agent_runtimes WHERE agent_id='po'")).rows[0].generation;
    const result = await call({ model: "custom-chat", stream: true }, env.token("po"), gen, "openai/v1/chat/completions");
    expect(result.statusCode).toBe(200); expect(result.body).not.toContain(KEY);
    expect(seen.at(-1)!.path).toBe("/v1/chat/completions");
    expect(seen.at(-1)!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen.at(-1)!.headers["x-api-key"]).toBeUndefined();
    expect([...env.driver.pods.values()].find(p => p.agentId === "po")!.providerKey).toBeNull();
  });
  it("cannot redirect an existing encrypted key to another endpoint and revocation takes effect without waiting for pod replacement", async () => {
    const c = (await env.call(env.owner, "GET", "/api/credentials")).body.credentials.find((k: any) => k.id === credential);
    expect((await env.call(env.owner, "PUT", `/api/credentials/${credential}/connection`, { revision: c.revision, protocol: "anthropic", baseUrl: "https://attacker.example/v1", authHeader: { name: "x-api-key", scheme: "raw" } })).status).toBe(400);
    expect((await env.call(env.owner, "DELETE", `/api/credentials/${credential}`)).status).toBe(204);
    expect((await call()).statusCode).toBe(409);
  });
  it("filters historical API text and multipart encoded key echoes without exposing partial characters", async () => {
    const ownerId = (await env.instance.authenticate(env.owner))!.id;
    const chatId = "chat-key-history";
    await env.db.query("INSERT INTO owner_chats(id,org_id,user_id,config) VALUES($1,'agentown',$2,$3)", [chatId, ownerId, JSON.stringify({ credentialId: credential, model: "claude-haiku-5-5", effort: "medium", contextLimit: 64000, maxOutputTokens: 4096, maxTurns: 20, approvalMode: "important" })]);
    await env.db.query("INSERT INTO owner_chat_messages(chat_id,role,text) VALUES($1,'assistant',$2)", [chatId, KEY]);
    expect(JSON.stringify((await env.call(env.owner, "GET", `/api/owner-chats/${chatId}`)).body)).not.toContain(KEY);
    const arbitrary = "test-secret-fragment-ABCDEFGHIJKLMNOPQRSTUVWXYZ"; registerProviderKey(arbitrary);
    const raw = new TextEncoder().encode(`prefix ${arbitrary} suffix`);
    const filtered = redactedBody(new ReadableStream({ start(c) { for (const byte of raw) c.enqueue(new Uint8Array([byte])); c.close(); } }));
    expect(await new Response(filtered).text()).toBe("prefix [redacted] suffix");
    expect(redactProviderKeys(Buffer.from(arbitrary).toString("base64"))).toBe("[redacted]");
    expect(redactProviderKeys(`Old hint …${arbitrary.slice(-4)}`)).toBe("Old hint [redacted]");
  });
});
