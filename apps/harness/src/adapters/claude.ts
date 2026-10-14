import Anthropic from "@anthropic-ai/sdk";
import { runShell } from "./script.ts";
import { ScriptAdapter } from "./script.ts";
import type { Adapter, RunContext, RunResult } from "./types.ts";

const MAX_TURNS = 40;
const TOOL_OUTPUT_LIMIT = 20_000;

/**
 * LLM adapter: a manual tool-use loop with the Anthropic-defined bash tool.
 * Commands run inside this agent's own runtime (non-root, no Kubernetes token,
 * egress limited by NetworkPolicy), as this agent. The model can call the
 * `agentown` CLI, but every call is authorized by the server against this
 * agent's grants — the model cannot widen them.
 *
 * NOTE: not verified against the live API in this repository's CI (needs an
 * ANTHROPIC_API_KEY in the cluster Secret `agentown-provider`).
 */
export class ClaudeAdapter implements Adapter {
  private readonly client: Anthropic;
  private readonly fallback = new ScriptAdapter();

  constructor(
    private readonly model: string,
    private readonly identity: { agentId: string; displayName: string; jobRole: string },
  ) {
    this.client = new Anthropic();
  }

  async run(ctx: RunContext): Promise<RunResult> {
    // Playbooks/scripts are deterministic even on an LLM runtime.
    if (ctx.task.spec.kind !== "prompt") return this.fallback.run(ctx);

    const system = [
      `You are ${this.identity.displayName}, an AI agent working as "${this.identity.jobRole}" in the Agentown organization (agent id ${this.identity.agentId}).`,
      `You work inside your own Linux container. Your persistent workspace is /workspace; the working directory for this task is ${ctx.workdir}.`,
      `Put deliverables (files the requester should receive) in ${ctx.outputDir}; they are uploaded as task artifacts when you finish.`,
      "The `agentown` CLI talks to the organization API as you: `agentown help` lists commands (view tasks, download input artifacts, create/assign tasks, spawn agents if you are allowed).",
      "The server enforces your permissions; a 403 means you are not allowed — do not try to work around it.",
      "When done, reply with a short summary of what you delivered. If you cannot proceed without someone else's input, start your final reply with BLOCKED: and say what you need.",
    ].join("\n");
    const user = [
      `Task ${ctx.task.id}: ${ctx.task.title}`,
      ctx.task.description && `\nDescription:\n${ctx.task.description}`,
      ctx.task.acceptanceCriteria && `\nAcceptance criteria:\n${ctx.task.acceptanceCriteria}`,
      ctx.task.inputTaskIds.length ? `\nInput tasks (use \`agentown task get <id>\` and \`agentown task artifacts <id> <dir>\`): ${ctx.task.inputTaskIds.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, turns: 0 };
    const env = {
      AGENTOWN_TASK_ID: ctx.task.id,
      AGENTOWN_RUN_ID: ctx.runId,
      AGENTOWN_OUTPUT_DIR: ctx.outputDir,
      AGENTOWN_STATE_FILE: ctx.stateFile,
    };

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (ctx.signal.aborted) return { outcome: "failed", summary: "aborted", usage };
      ctx.setState("thinking", `turn ${turn + 1}`);
      // Server-side refusal fallback ("default" routing) is enabled so a safety
      // decline is retried on a fallback model inside the same call.
      const params = {
        model: this.model,
        max_tokens: 16000,
        system,
        tools: [{ type: "bash_20250124", name: "bash" }],
        messages,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      };
      const response = (await this.client.beta.messages.create(params as any, { signal: ctx.signal })) as unknown as Anthropic.Message;
      usage.turns++;
      usage.input_tokens += response.usage.input_tokens;
      usage.output_tokens += response.usage.output_tokens;
      usage.cache_read_input_tokens += response.usage.cache_read_input_tokens ?? 0;

      if (response.stop_reason === "refusal") {
        return { outcome: "failed", summary: "model declined the request (refusal)", usage };
      }
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) ctx.log("agent", text);
      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "pause_turn") continue;
      const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || calls.length === 0) {
        if (response.stop_reason === "max_tokens") return { outcome: "failed", summary: "hit max_tokens", usage };
        if (text.startsWith("BLOCKED:")) return { outcome: "blocked", summary: text.slice(8).trim(), usage };
        return { outcome: "succeeded", summary: text || "done", usage };
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        const input = call.input as { command?: string; restart?: boolean };
        if (call.name !== "bash") {
          results.push({ type: "tool_result", tool_use_id: call.id, content: `unknown tool ${call.name}`, is_error: true });
          continue;
        }
        if (input.restart) {
          results.push({ type: "tool_result", tool_use_id: call.id, content: "shell restarted (each command runs in a fresh shell)" });
          continue;
        }
        const command = String(input.command ?? "");
        ctx.setState("executing", command.slice(0, 120));
        ctx.log("agent", `$ ${command}`);
        const { code, output } = await runShell(ctx, ["/bin/sh", "-c", command], env, { timeoutMs: 300_000, captureLimit: 2000 });
        let out = output.join("\n");
        if (out.length > TOOL_OUTPUT_LIMIT) out = `${out.slice(0, TOOL_OUTPUT_LIMIT)}\n[output truncated]`;
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: `${out}\n[exit code ${code}]`,
          is_error: code !== 0,
        });
      }
      messages.push({ role: "user", content: results });
    }
    return { outcome: "failed", summary: `stopped after ${MAX_TURNS} turns`, usage };
  }
}
