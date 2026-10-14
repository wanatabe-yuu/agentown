import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../src/adapters/claude.ts";
import type { RunContext } from "../src/adapters/types.ts";

/**
 * Exercises the tool-use loop against a local stand-in for POST /v1/messages:
 * turn 1 asks for a bash command, turn 2 finishes. Verifies the request shape
 * (per-agent model/effort/instructions, bash tool, refusal fallback) and that
 * the command really ran in the task workspace.
 */
const requests: Array<{ headers: http.IncomingHttpHeaders; body: any }> = [];
let server: http.Server;
const savedProvider = process.env.AGENTOWN_LLM_PROVIDER;
const saved = { url: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push({ headers: req.headers, body });
      const first = requests.length === 1;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: `msg_${requests.length}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: first
            ? [
                { type: "text", text: "Writing the file." },
                { type: "tool_use", id: "toolu_1", name: "bash", input: { command: 'echo "hello" > "$AGENTOWN_OUTPUT_DIR/hello.txt" && echo wrote' } },
              ]
            : [{ type: "text", text: "Created hello.txt in the output directory." }],
          stop_reason: first ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.ANTHROPIC_API_KEY = "sk-local-test";
});

beforeEach(() => { requests.length = 0; delete process.env.AGENTOWN_LLM_PROVIDER; });
afterAll(() => {
  if (savedProvider === undefined) delete process.env.AGENTOWN_LLM_PROVIDER; else process.env.AGENTOWN_LLM_PROVIDER = savedProvider;
  server.close();
  process.env.ANTHROPIC_BASE_URL = saved.url;
  process.env.ANTHROPIC_API_KEY = saved.key;
});

describe("ClaudeAdapter", () => {
  it("runs the tool loop with the agent's own settings", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agentown-claude-"));
    const outputDir = join(workdir, "out");
    mkdirSync(outputDir);
    const logs: string[] = [];
    const ctx: RunContext = {
      config: { harness: "claude", model: "claude-sonnet-5-5", effort: "high", instructions: "Always write tests first.", maxTurns: 5, hasCredential: true },
      task: { id: "t-1", title: "Say hello", description: "write hello.txt", acceptanceCriteria: "file exists", spec: { kind: "prompt" }, inputTaskIds: [], parentTaskId: null, projectId: null },
      runId: "r-1",
      workdir,
      outputDir,
      stateFile: join(workdir, "state.json"),
      signal: new AbortController().signal,
      log: (_s, l) => logs.push(l),
      setState: () => {},
      event: () => {},
    };
    const result = await new ClaudeAdapter("claude-opus-5-5", { agentId: "a-1", displayName: "Claudia", jobRole: "engineer" }).run(ctx);

    expect(result.outcome).toBe("succeeded");
    expect(result.summary).toMatch(/hello\.txt/);
    expect(result.usage).toMatchObject({ model: "claude-sonnet-5-5", turns: 2, input_tokens: 200, output_tokens: 40 });
    expect(existsSync(join(outputDir, "hello.txt")) && readFileSync(join(outputDir, "hello.txt"), "utf8").trim()).toBe("hello");

    const [first, second] = requests;
    expect(first!.body.model).toBe("claude-sonnet-5-5");
    expect(first!.body.output_config).toEqual({ effort: "high" });
    expect(first!.body.system).toContain("Always write tests first.");
    expect(first!.body.tools).toEqual([{ type: "bash_20250124", name: "bash" }]);
    expect(first!.body.fallbacks).toBe("default");
    expect(String(first!.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    expect(first!.headers["x-api-key"]).toBe("sk-local-test");
    const toolResult = second!.body.messages.at(-1).content[0];
    expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1", is_error: false });
    expect(toolResult.content).toContain("wrote");
  });

  it("uses standard tools for custom Claude gateways and still executes tool results without native extensions", async () => {
    process.env.AGENTOWN_LLM_PROVIDER = "custom";
    const workdir = mkdtempSync(join(tmpdir(), "agentown-custom-claude-"));
    const outputDir = join(workdir, "out"); mkdirSync(outputDir);
    const ctx: RunContext = {
      config: { harness: "claude", provider: "custom", model: "claude-haiku-5-5", effort: "medium", instructions: "Keep it short.", maxTurns: 5, hasCredential: true },
      task: { id: "t-custom", title: "Say hello", description: "write hello.txt", acceptanceCriteria: "file exists", spec: { kind: "prompt" }, inputTaskIds: [], parentTaskId: null, projectId: null },
      runId: "r-custom", workdir, outputDir, stateFile: join(workdir, "state.json"), signal: new AbortController().signal, log: () => {}, setState: () => {}, event: () => {},
    };
    const result = await new ClaudeAdapter("claude-haiku-5-5", { agentId: "custom", displayName: "Custom", jobRole: "engineer" }).run(ctx);
    expect(result.outcome).toBe("succeeded");
    expect(readFileSync(join(outputDir, "hello.txt"), "utf8").trim()).toBe("hello");
    const [first, second] = requests;
    expect(first!.body.tools[0]).toMatchObject({ name: "bash", input_schema: { type: "object", required: ["command"] } });
    expect(first!.body.tools[0].type).toBeUndefined();
    expect(first!.body.fallbacks).toBeUndefined();
    expect(first!.headers["anthropic-beta"]).toBeUndefined();
    expect(first!.body.output_config).toEqual({ effort: "medium" });
    expect(second!.body.messages.at(-1).content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1", is_error: false });
  });
  it("blocks instead of failing silently when no key is configured", async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const r = await new ClaudeAdapter("claude-opus-5-5", { agentId: "a", displayName: "a", jobRole: "x" }).run({
      config: { harness: "claude", model: null, effort: null, instructions: "", maxTurns: 3, hasCredential: false },
      task: { id: "t", title: "t", description: "", acceptanceCriteria: "", spec: { kind: "prompt" }, inputTaskIds: [], parentTaskId: null, projectId: null },
    } as unknown as RunContext);
    process.env.ANTHROPIC_API_KEY = key;
    expect(r.outcome).toBe("blocked");
  });
});
