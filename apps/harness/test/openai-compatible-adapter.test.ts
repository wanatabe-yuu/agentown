import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpenAICompatibleAdapter } from "../src/adapters/openai-compatible.ts";
import type { RunContext } from "../src/adapters/types.ts";

/**
 * Exercises the Chat Completions tool loop against a local stand-in for
 * POST /chat/completions: one rate-limited attempt, then a bash tool call, then
 * a final answer. Verifies the request shape, the retry, and that the command
 * really ran in the task workspace without seeing the provider key.
 */
type Reply = { status: number; body: unknown; headers?: Record<string, string> };
const requests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: any }> = [];
let replies: Reply[] = [];
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw) });
      const r = replies.shift() ?? { status: 500, body: { error: "no reply queued" } };
      res.writeHead(r.status, { "content-type": "application/json", ...r.headers });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterAll(() => server.close());
beforeEach(() => {
  requests.length = 0;
  replies = [];
});

function context(model: string | null, effort: RunContext["config"]["effort"] = null) {
  const workdir = mkdtempSync(join(tmpdir(), "agentown-oai-"));
  const outputDir = join(workdir, "out");
  mkdirSync(outputDir);
  const ctx: RunContext = {
    config: { harness: "claude", provider: "openai", model, effort, instructions: "Keep it short.", maxTurns: 5, hasCredential: true },
    task: { id: "t-1", title: "Say hello", description: "write hello.txt", acceptanceCriteria: "file exists", spec: { kind: "prompt" }, inputTaskIds: [], parentTaskId: null, projectId: null },
    runId: "r-1",
    workdir,
    outputDir,
    stateFile: join(workdir, "state.json"),
    signal: new AbortController().signal,
    log: () => {},
    setState: () => {},
    event: () => {},
  };
  return ctx;
}

const identity = { agentId: "a-1", displayName: "Gwen", jobRole: "engineer" };
const noSleep = async () => {};

describe("OpenAICompatibleAdapter", () => {
  it("runs the tool loop, retries a 429, and keeps the key away from commands", async () => {
    process.env.AGENTOWN_LLM_API_KEY = "sk-oai-local";
    replies = [
      { status: 429, body: { error: { message: "slow down" } }, headers: { "retry-after": "1" } },
      {
        status: 200,
        body: {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "need a file",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "bash", arguments: JSON.stringify({ command: 'echo "hello" > "$AGENTOWN_OUTPUT_DIR/hello.txt"; echo "key=${AGENTOWN_LLM_API_KEY:-unset}"' }) },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        },
      },
      { status: 200, body: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Created hello.txt." } }], usage: { prompt_tokens: 150, completion_tokens: 10 } } },
    ];
    const ctx = context("gpt-test", "xhigh");
    const result = await new OpenAICompatibleAdapter({ provider: "openai", baseUrl, apiKey: "sk-oai-local", identity, sleep: noSleep }).run(ctx);
    delete process.env.AGENTOWN_LLM_API_KEY;

    expect(result).toMatchObject({ outcome: "succeeded", summary: "Created hello.txt." });
    expect(result.usage).toMatchObject({ provider: "openai", model: "gpt-test", turns: 2, input_tokens: 250, output_tokens: 30 });
    expect(existsSync(join(ctx.outputDir, "hello.txt")) && readFileSync(join(ctx.outputDir, "hello.txt"), "utf8").trim()).toBe("hello");

    expect(requests).toHaveLength(3);
    const [, first, second] = requests;
    expect(first!.url).toBe("/v1/chat/completions");
    expect(first!.headers.authorization).toBe("Bearer sk-oai-local");
    expect(first!.body).toMatchObject({ model: "gpt-test", reasoning_effort: "high" });
    expect(first!.body.messages[0]).toMatchObject({ role: "system" });
    expect(first!.body.messages[0].content).toContain("Keep it short.");
    expect(first!.body.tools[0]).toMatchObject({ type: "function", function: { name: "bash" } });
    const [assistant, tool] = second!.body.messages.slice(-2);
    expect(assistant).toMatchObject({ role: "assistant", content: "", reasoning_content: "need a file", tool_calls: [{ id: "call_1" }] });
    expect(tool).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(tool.content).toContain("key=unset");
    expect(tool.content).toContain("[exit code 0]");
  });

  it("works without a key, sends no provider-specific fields, and answers bad tool calls", async () => {
    replies = [
      {
        status: 200,
        body: {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  { id: "c1", type: "function", function: { name: "python", arguments: "{}" } },
                  { id: "c2", type: "function", function: { name: "bash", arguments: "{not json" } },
                ],
              },
            },
          ],
        },
      },
      { status: 200, body: { choices: [{ finish_reason: "stop", message: { content: "Asked the owner.\n\nBLOCKED: need a spec" } }] } },
    ];
    const result = await new OpenAICompatibleAdapter({ provider: "custom", baseUrl, apiKey: undefined, identity, sleep: noSleep }).run(context("llama3.3", "high"));
    expect(result).toMatchObject({ outcome: "blocked", summary: "need a spec" });
    expect(requests[0]!.headers.authorization).toBeUndefined();
    expect(requests[0]!.body.reasoning_effort).toBeUndefined();
    const tools = requests[1]!.body.messages.filter((m: any) => m.role === "tool");
    expect(tools.map((m: any) => m.tool_call_id)).toEqual(["c1", "c2"]);
    expect(tools[0].content).toContain("unknown tool python");
    expect(tools[1].content).toContain("not valid JSON");
  });

  it("explains a custom gateway protocol mismatch without echoing the provider response", async () => {
    replies = [{ status: 200, body: { type: "message", content: [{ type: "text", text: "sensitive provider echo" }] } }];
    const result = await new OpenAICompatibleAdapter({ provider: "custom", baseUrl, apiKey: undefined, identity, sleep: noSleep }).run(context("claude-haiku-5-5"));
    expect(result.outcome).toBe("failed"); expect(result.summary).toContain("Anthropic / Claude");
    expect(result.summary).not.toContain("sensitive provider echo"); expect(requests).toHaveLength(1);
  });
  it("fails on a non-retryable error and blocks when no model is chosen", async () => {
    replies = [{ status: 401, body: { error: { message: "bad key" } } }];
    await expect(new OpenAICompatibleAdapter({ provider: "deepseek", baseUrl, apiKey: "k", identity, sleep: noSleep }).run(context("deepseek-chat"))).rejects.toThrow(/deepseek 401/);
    expect(requests).toHaveLength(1);

    const r = await new OpenAICompatibleAdapter({ provider: "deepseek", baseUrl, apiKey: "k", identity }).run(context(null));
    expect(r).toMatchObject({ outcome: "blocked" });
    expect(r.summary).toContain("no model");
  });
});
