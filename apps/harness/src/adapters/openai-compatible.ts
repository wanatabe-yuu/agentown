import { type AgentIdentity, NO_CREDENTIAL, runBashTool, taskPrompts } from "./common.ts";
import { ScriptAdapter } from "./script.ts";
import type { Adapter, RunContext, RunResult } from "./types.ts";

/**
 * LLM adapter for every provider that speaks the OpenAI-compatible Chat
 * Completions API (OpenAI, DeepSeek, xAI Grok, Gemini, Mistral, Groq,
 * OpenRouter, Together, or a custom endpoint such as Ollama or vLLM).
 *
 * Same contract as the Claude adapter: a manual tool-use loop with one `bash`
 * function, commands run inside this agent's own runtime as this agent, and
 * every `agentown` CLI call is authorized by the server against its grants.
 * Plain `fetch`, no SDK: the request shape is small and stable across providers.
 */

interface ToolCall {
  id: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

interface ChatResponse {
  choices?: Array<{ message?: Partial<ChatMessage>; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const BASH_TOOL = {
  type: "function",
  function: {
    name: "bash",
    description:
      "Run a shell command in your Linux container (a fresh /bin/sh for every call, working directory = the task directory). Returns combined stdout/stderr and the exit code.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command to run." } },
      required: ["command"],
    },
  },
};

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const REQUEST_TIMEOUT_MS = 600_000;

export interface OpenAICompatibleOptions {
  provider: string;
  baseUrl: string;
  apiKey: string | undefined;
  identity: AgentIdentity;
  /** Waits between retries; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

export class OpenAICompatibleAdapter implements Adapter {
  private readonly fallback = new ScriptAdapter();

  constructor(private readonly opts: OpenAICompatibleOptions) {}

  async run(ctx: RunContext): Promise<RunResult> {
    // Playbooks/scripts are deterministic even on an LLM runtime.
    if (ctx.task.spec.kind !== "prompt") return this.fallback.run(ctx);
    if (!this.opts.baseUrl) return { outcome: "blocked", summary: NO_CREDENTIAL };
    const model = ctx.config.model;
    if (!model) return { outcome: "blocked", summary: "no model is set for this agent (choose one in the agent's Config tab)" };
    const { system, user } = taskPrompts(ctx, this.opts.identity);
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    const usage = { provider: this.opts.provider, model, input_tokens: 0, output_tokens: 0, turns: 0 };

    for (let turn = 0; turn < ctx.config.maxTurns; turn++) {
      if (ctx.signal.aborted) return { outcome: "failed", summary: "aborted", usage };
      ctx.setState("thinking", `turn ${turn + 1}`);
      const body: Record<string, unknown> = { model, messages, tools: [BASH_TOOL] };
      const effort = reasoningEffort(this.opts.provider, ctx.config.effort);
      if (effort) body.reasoning_effort = effort;
      const response = await this.complete(body, ctx.signal);
      usage.turns++;
      usage.input_tokens += response.usage?.prompt_tokens ?? 0;
      usage.output_tokens += response.usage?.completion_tokens ?? 0;

      const choice = response.choices?.[0];
      if (!choice?.message) return { outcome: "failed", summary: "the provider returned no message", usage };
      const msg = choice.message;
      const text = typeof msg.content === "string" ? msg.content.trim() : "";
      if (text) ctx.log("agent", text);
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      messages.push({
        role: "assistant",
        content: typeof msg.content === "string" ? msg.content : "",
        ...(calls.length ? { tool_calls: calls } : {}),
        // DeepSeek thinking mode expects its reasoning back while a tool loop is in progress.
        ...(calls.length && typeof msg.reasoning_content === "string" ? { reasoning_content: msg.reasoning_content } : {}),
      });

      if (!calls.length) {
        if (choice.finish_reason === "length") return { outcome: "failed", summary: "hit the output token limit", usage };
        if (choice.finish_reason === "content_filter") return { outcome: "failed", summary: "the provider's content filter stopped the response", usage };
        if (text.startsWith("BLOCKED:")) return { outcome: "blocked", summary: text.slice(8).trim(), usage };
        return { outcome: "succeeded", summary: text || "done", usage };
      }

      for (const call of calls) {
        const reply = (content: string) => messages.push({ role: "tool", tool_call_id: call.id, content });
        if (call.function?.name !== "bash") {
          reply(`error: unknown tool ${call.function?.name ?? "(none)"}; the only tool is bash`);
          continue;
        }
        let command: unknown;
        try {
          command = (JSON.parse(call.function.arguments || "{}") as { command?: unknown }).command;
        } catch {
          reply('error: the arguments were not valid JSON; call bash with {"command": "..."}');
          continue;
        }
        if (typeof command !== "string" || !command.trim()) {
          reply('error: missing "command"; call bash with {"command": "..."}');
          continue;
        }
        const { content } = await runBashTool(ctx, command);
        reply(content);
      }
    }
    return { outcome: "failed", summary: `stopped after ${ctx.config.maxTurns} turns`, usage };
  }

  private async complete(body: Record<string, unknown>, signal: AbortSignal): Promise<ChatResponse> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      const text = await res.text();
      if (res.ok) {
        try {
          return JSON.parse(text) as ChatResponse;
        } catch {
          throw new Error(`${this.opts.provider}: response was not JSON`);
        }
      }
      if (!RETRYABLE.has(res.status) || attempt >= 2) throw new Error(`${this.opts.provider} ${res.status}: ${text.slice(0, 500)}`);
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 2000 * 2 ** attempt);
    }
  }
}

/** Only OpenAI documents `reasoning_effort` on Chat Completions; other providers may reject unknown fields. */
function reasoningEffort(provider: string, effort: RunContext["config"]["effort"]): string | null {
  if (provider !== "openai" || !effort) return null;
  return effort === "low" || effort === "medium" ? effort : "high";
}
