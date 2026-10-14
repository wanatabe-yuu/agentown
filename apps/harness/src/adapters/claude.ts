import Anthropic from "@anthropic-ai/sdk";
import { type AgentIdentity, NO_CREDENTIAL, runBashTool, taskPrompts } from "./common.ts";
import { ScriptAdapter } from "./script.ts";
import type { Adapter, RunContext, RunResult } from "./types.ts";

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
    private readonly defaultModel: string,
    private readonly identity: AgentIdentity,
  ) {
    // Reads ANTHROPIC_API_KEY: this agent's own key, mounted from its per-agent secret.
    // A key made at the organization level (not inside a workspace) must name its workspace on every request.
    const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
    this.client = new Anthropic(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {});
  }

  async run(ctx: RunContext): Promise<RunResult> {
    // Playbooks/scripts are deterministic even on an LLM runtime.
    if (ctx.task.spec.kind !== "prompt") return this.fallback.run(ctx);
    if (!process.env.ANTHROPIC_API_KEY) {
      return { outcome: "blocked", summary: NO_CREDENTIAL };
    }
    const model = ctx.config.model ?? this.defaultModel;
    const maxTurns = ctx.config.maxTurns;

    const { system, user } = taskPrompts(ctx, this.identity);

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];
    const usage = { model, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, turns: 0 };
    for (let turn = 0; turn < maxTurns; turn++) {
      if (ctx.signal.aborted) return { outcome: "failed", summary: "aborted", usage };
      ctx.setState("thinking", `turn ${turn + 1}`);
      // Server-side refusal fallback ("default" routing) is enabled so a safety
      // decline is retried on a fallback model inside the same call.
      const params = {
        model,
        ...(ctx.config.effort ? { output_config: { effort: ctx.config.effort } } : {}),
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
        const { content, isError } = await runBashTool(ctx, String(input.command ?? ""));
        results.push({ type: "tool_result", tool_use_id: call.id, content, is_error: isError });
      }
      messages.push({ role: "user", content: results });
    }
    return { outcome: "failed", summary: `stopped after ${maxTurns} turns`, usage };
  }
}
