import { createServer } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicChatModel, CompatibleChatModel, anthropicMessages, anthropicUsage } from "../src/chat/provider.ts";
import { chatConfigSchema, type ModelInput } from "../src/chat/types.ts";

const input = (): ModelInput => ({ system: "Owner instructions", messages: [{ role: "user", text: "Read world" }],
  tools: [{ name: "inspect", description: "Read current world", schema: z.object({ kind: z.string() }).strict(), execute: async () => ({ ok: true }) }],
  config: chatConfigSchema.parse({ credentialId: "k-test", model: "test-model", effort: "medium" }),
  info: { contextWindow: 100000, maxOutputTokens: 10000, nativeCompaction: true, efforts: ["medium"], adaptiveThinking: true }, signal: new AbortController().signal });

describe("owner chat provider protocol", () => {
  it("preserves native thinking/tool blocks, groups tool results and counts compaction iterations once", () => {
    const native = [{ type: "thinking", thinking: "private", signature: "opaque" }, { type: "tool_use", id: "one", name: "inspect", input: {} }];
    const messages = anthropicMessages([{ role: "assistant", text: "", native }, { role: "tool", toolId: "one", text: "result" }, { role: "tool", toolId: "two", text: "failed", isError: true }]);
    expect(messages[0].content).toEqual(native); expect(messages[1].content).toHaveLength(2);
    const u = anthropicUsage({ input_tokens: 999, output_tokens: 999, iterations: [{ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30 }, { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 12 }] });
    expect(u.inputTokens).toBe(152); expect(u.outputTokens).toBe(25); expect(u.cachedTokens).toBe(30);
  });
  it("discovers real capabilities and sends count, effort, adaptive thinking and signed native compaction", async () => {
    const requests: Array<{ kind: string; params: any; options: any }> = [];
    const block = { type: "compaction", content: "Summary with IDs", signature: "signed-provider-block" };
    const client = { models: { retrieve: async (_id: string, _params: any, options: any) => {
      requests.push({ kind: "info", params: {}, options });
      return { max_input_tokens: 1000000, max_tokens: 128000, capabilities: { compaction: { supported: true }, effort: { supported: true, medium: { supported: true } }, thinking: { types: { adaptive: { supported: true } } } } };
    } }, beta: { messages: {
      countTokens: async (params: any, options: any) => { requests.push({ kind: "count", params, options }); return { input_tokens: 1400 }; },
      create: async (params: any, options: any) => { requests.push({ kind: "compact", params, options }); return { stop_reason: "compaction", content: [block], usage: { iterations: [{ input_tokens: 100, output_tokens: 40 }] } }; },
      stream: (params: any, options: any) => {
        requests.push({ kind: "complete", params, options });
        return { on: (_event: string, fn: (s: string) => void) => fn("Visible reply"), finalMessage: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Visible reply" }], usage: { input_tokens: 100, output_tokens: 10 } }) };
      },
    } } };
    const model = new AnthropicChatModel({ provider: "anthropic", apiKey: "test-only", workspaceId: null, baseUrl: null }, client as unknown as Anthropic);
    const i = input(); i.info = await model.info(i.config.model, i.signal);
    expect(i.info.contextWindow).toBe(1000000); expect(i.info.nativeCompaction).toBe(true);
    const compact = await model.compact(i); expect(compact.message).toMatchObject({ native: [block] });
    i.messages = [compact.message, { role: "user", text: "Continue" }];
    expect((await model.count(i)).mode).toBe("api"); let streamed = ""; i.onText = t => streamed += t;
    await model.complete(i); expect(streamed).toBe("Visible reply");
    expect(requests.find(r => r.kind === "count")!.params.messages[0].content[0]).toEqual(block);
    const complete = requests.find(r => r.kind === "complete")!.params;
    expect(complete.betas).toContain("compact-2026-09-04"); expect(complete.output_config.effort).toBe("medium"); expect(complete.thinking.type).toBe("adaptive");
    expect(requests.find(r => r.kind === "compact")!.params.compaction).toEqual({ type: "summarize" });
  });
  it("parses fragmented compatible streaming tools and actual usage, with estimates clearly labelled", async () => {
    let request: any;
    const server = createServer(async (req, res) => {
      let body = ""; for await (const chunk of req) body += chunk; request = JSON.parse(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const parts = [
        { choices: [{ delta: { content: "Xin chào ", tool_calls: [{ index: 0, id: "call-one", function: { name: "inspect", arguments: '{"ki' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'nd":"snapshot"}' } }] }, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 123, completion_tokens: 45, prompt_tokens_details: { cached_tokens: 40 } } },
      ];
      const bytes = Buffer.from(parts.map(p => `data: ${JSON.stringify(p)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n");
      for (let n = 0; n < bytes.length; n += 7) res.write(bytes.subarray(n, n + 7)); res.end();
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const model = new CompatibleChatModel({ provider: "openai", apiKey: "test-only", workspaceId: null, baseUrl: `http://127.0.0.1:${port}` });
      const i = input(); let text = ""; i.onText = t => text += t;
      expect((await model.count(i)).mode).toBe("estimated");
      const result = await model.complete(i);
      expect(result.message.calls).toEqual([{ id: "call-one", name: "inspect", args: { kind: "snapshot" } }]);
      expect(text).toBe("Xin chào "); expect(result.usage.inputTokens).toBe(123); expect(result.usage.cachedTokens).toBe(40);
      expect(request.reasoning_effort).toBe("medium"); expect(request.stream_options.include_usage).toBe(true); expect(request.max_completion_tokens).toBe(4096);
    } finally { await new Promise<void>(r => server.close(() => r())); }
  });
  it("never exposes provider response bodies, and refuses unfinished tool arguments", async () => {
    let mode = "error";
    const server = createServer((_req, res) => {
      if (mode === "error") { res.writeHead(400); res.end('context too long test-private-provider-value'); }
      else { res.writeHead(200, { "content-type": "text/event-stream" }); res.end('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"one","function":{"name":"inspect","arguments":"{broken"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'); }
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    try {
      const model = new CompatibleChatModel({ provider: "custom", apiKey: "", workspaceId: null, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
      await expect(model.complete(input())).rejects.toMatchObject({ contextOverflow: true });
      await model.complete(input()).catch(e => expect(e.message).not.toContain("test-private-provider-value"));
      mode = "broken"; await expect(model.complete(input())).rejects.toThrow(/connection failed/);
    } finally { await new Promise<void>(r => server.close(() => r())); }
  });
});
