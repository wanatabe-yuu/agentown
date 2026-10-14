import { createServer, type IncomingHttpHeaders } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { listModels } from "../src/providers.ts";
import { createChatModel, AnthropicChatModel } from "../src/chat/provider.ts";
import { chatConfigSchema, type ModelInput } from "../src/chat/types.ts";
import { ClaudeAdapter } from "../../harness/src/adapters/claude.ts";
import type { RunContext } from "../../harness/src/adapters/types.ts";
import { llmEnv } from "../src/runtime/driver.ts";
import { authHeaderSchema } from "@agentown/core";

const seen: Array<{ url: string; headers: IncomingHttpHeaders; body: any }> = [];
let base: string;
let missingMetadata = false;
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", chunk => { raw += chunk; });
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : null;
    const path = new URL(req.url!, "http://test.local").pathname;
    seen.push({ url: path, headers: req.headers, body });
    res.setHeader("content-type", "application/json");
    if (path === "/gateway/v1/models") return res.end(JSON.stringify({ data: [{ id: "claude-test", type: "model", display_name: "Claude test", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: "claude-test", last_id: "claude-test" }));
    if (missingMetadata && path !== "/gateway/v1/messages") { res.statusCode = 404; return res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "unsupported endpoint" } })); }
    if (path === "/gateway/v1/models/claude-test") return res.end(JSON.stringify({ id: "claude-test", type: "model", max_input_tokens: 100000, max_tokens: 8192, capabilities: { effort: { supported: true, medium: { supported: true } } } }));
    if (path === "/gateway/v1/messages/count_tokens") return res.end(JSON.stringify({ input_tokens: 321 }));
    if (path !== "/gateway/v1/messages" && path !== "/gateway/api/runtime/llm/anthropic/v1/messages") { res.statusCode = 404; return res.end("{}"); }
    const message = { id: "msg_gateway", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "Gateway works." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 12, output_tokens: 4 } };
    if (!body.stream) return res.end(JSON.stringify(message));
    res.setHeader("content-type", "text/event-stream");
    for (const event of [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Gateway works." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
});
beforeAll(async () => { await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}/gateway/v1`; });
afterEach(() => { missingMetadata = false; seen.length = 0; vi.unstubAllEnvs(); });
afterAll(() => new Promise<void>(r => server.close(() => r())));
const target = () => ({ provider: "custom" as const, protocol: "anthropic" as const, baseUrl: base, apiKey: "fake-gateway-key", authHeader: { name: "x-api-key", scheme: "raw" as const }, workspaceId: null });
const input = (): ModelInput => ({ system: "Owner instructions", messages: [{ role: "user", text: "Hello" }], tools: [], config: chatConfigSchema.parse({ credentialId: "k-test", model: "claude-test", effort: "medium" }), info: { contextWindow: null, maxOutputTokens: null, nativeCompaction: false, efforts: null }, signal: new AbortController().signal });

describe("custom Anthropic URL and auth", () => {
  it("uses the gateway for models, capabilities, count and streamed owner responses with x-api-key only", async () => {
    expect(await listModels(target())).toEqual(["claude-test"]);
    const model = createChatModel(target()); expect(model).toBeInstanceOf(AnthropicChatModel);
    const i = input(); i.info = await model.info(i.config.model, i.signal);
    expect(i.info.contextWindow).toBe(100000);
    expect(await model.count(i)).toEqual({ tokens: 321, mode: "api" });
    expect((await model.complete(i)).message.text).toBe("Gateway works.");
    expect(seen.map(r => r.url)).toEqual(["/gateway/v1/models", "/gateway/v1/models/claude-test", "/gateway/v1/messages/count_tokens", "/gateway/v1/messages"]);
    for (const r of seen) { expect(r.headers["x-api-key"]).toBe("fake-gateway-key"); expect(r.headers.authorization).toBeUndefined(); expect(r.headers["anthropic-version"]).toBeTruthy(); }
    expect(seen.at(-1)!.body.output_config).toEqual({ effort: "medium" });
  });
  it("sends a custom auth header without duplicate SDK authentication and keeps chat usable without metadata/count endpoints", async () => {
    const t = { ...target(), authHeader: { name: "x-gateway-key", scheme: "bearer" as const } };
    expect(await listModels(t)).toEqual(["claude-test"]);
    missingMetadata = true;
    const model = createChatModel(t); const i = input(); i.info = await model.info(i.config.model, i.signal);
    expect(i.info.nativeCompaction).toBe(false); expect(i.info.contextWindow).toBeNull();
    expect((await model.count(i)).mode).toBe("estimated");
    expect((await model.complete(i)).message.text).toBe("Gateway works.");
    expect((await model.compact(i)).message.text).toContain("Gateway works.");
    for (const r of seen) { expect(r.headers["x-gateway-key"]).toBe("Bearer fake-gateway-key"); expect(r.headers["x-api-key"]).toBeUndefined(); expect(r.headers.authorization).toBeUndefined(); }
    expect(seen.at(-1)!.body.tools).toEqual([]);
    expect(seen.at(-1)!.body.output_config).toEqual({ effort: "medium" });
  });
  it("the Claude runtime uses the same gateway protocol, URL and header, with an identity token instead of a provider-key environment", async () => {
    const environment = llmEnv(target(), base.replace(/\/v1$/, ""));
    expect(environment.plain).toMatchObject({ AGENTOWN_LLM_PROVIDER: "custom", AGENTOWN_LLM_PROTOCOL: "anthropic", ANTHROPIC_BASE_URL: `${base.replace(/\/v1$/, "")}/api/runtime/llm/anthropic`, AGENTOWN_LLM_BROKER: "1" });
    expect(JSON.stringify(environment.plain)).not.toContain("fake-gateway-key");
    expect(environment.secret).toEqual({});
    for (const [k, v] of Object.entries({ ...environment.plain, ...environment.secret, AGENTOWN_TOKEN: "runtime-test-token", AGENTOWN_GENERATION: "2" })) vi.stubEnv(k, v);
    const result = await new ClaudeAdapter("claude-test", { agentId: "test", displayName: "Tester", jobRole: "engineer" }).run({
      config: { harness: "claude", model: "claude-test", effort: "medium", instructions: "", maxTurns: 2, hasCredential: true },
      task: { id: "t-test", title: "Hello", description: "", acceptanceCriteria: "", spec: { kind: "prompt" }, inputTaskIds: [], parentTaskId: null, projectId: null },
      signal: new AbortController().signal, setState: () => {}, log: () => {},
    } as unknown as RunContext);
    expect(result.outcome).toBe("succeeded"); expect(result.summary).toBe("Gateway works.");
    expect(seen[0]!.url).toBe("/gateway/api/runtime/llm/anthropic/v1/messages"); expect(seen[0]!.headers["x-api-key"]).toBeUndefined(); expect(seen[0]!.headers.authorization).toBe("Bearer runtime-test-token"); expect(seen[0]!.headers["x-agentown-generation"]).toBe("2");
  });
  it("falls back promptly when optional gateway metadata/count requests time out, while preserving cancellation and authorization errors", async () => {
    let countCalls = 0;
    const unavailable = Object.assign(new Error("optional endpoint timeout"), { name: "APIConnectionTimeoutError" });
    const client = { models: { retrieve: async () => { throw unavailable; } }, messages: { countTokens: async () => { countCalls++; throw unavailable; } } };
    const model = new AnthropicChatModel(target(), client as any); const i = input();
    expect((await model.info(i.config.model, i.signal)).efforts).toBeNull();
    expect((await model.count(i)).mode).toBe("estimated"); expect((await model.count(i)).mode).toBe("estimated"); expect(countCalls).toBe(1);
    const abort = new AbortController(); abort.abort();
    await expect(new AnthropicChatModel(target(), client as any).info(i.config.model, abort.signal)).rejects.toThrow();
    const forbidden = { models: { retrieve: async () => { throw { status: 403 }; } }, messages: { countTokens: async () => { throw { status: 401 }; } } };
    const denied = new AnthropicChatModel(target(), forbidden as any);
    await expect(denied.info(i.config.model, i.signal)).rejects.toThrow("HTTP 403");
    await expect(denied.count(i)).rejects.toThrow("HTTP 401");
  });
  it("treats malformed optional metadata and counts as unavailable rather than inventing capabilities", async () => {
    const client = { models: { retrieve: async () => ({ data: [{ id: "claude-test" }] }) }, messages: { countTokens: async () => ({ data: [] }) } };
    const model = new AnthropicChatModel(target(), client as any); const i = input();
    expect((await model.info(i.config.model, i.signal)).nativeCompaction).toBe(false);
    expect((await model.count(i)).mode).toBe("estimated");
    expect((await model.count(i)).tokens).toBeGreaterThan(0);
  });
  it("accepts auth names case insensitively but rejects transport headers and header injection", () => {
    expect(authHeaderSchema.parse({ name: " X-API-Key ", scheme: "raw" }).name).toBe("x-api-key");
    for (const name of ["bad\r\nheader", "host", "cookie", "content-type", "anthropic-version"]) expect(authHeaderSchema.safeParse({ name, scheme: "raw" }).success).toBe(false);
  });
});
