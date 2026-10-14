import { runShell } from "./script.ts";
import type { RunContext } from "./types.ts";

/** Shared by the LLM adapters: the agent's identity, the task prompt and the bash tool. */
export interface AgentIdentity {
  agentId: string;
  displayName: string;
  jobRole: string;
}

const TOOL_OUTPUT_LIMIT = 20_000;

export function taskPrompts(ctx: RunContext, identity: AgentIdentity): { system: string; user: string } {
  const system = [
    `You are ${identity.displayName}, an AI agent working as "${identity.jobRole}" in the Agentown organization (agent id ${identity.agentId}).`,
    `You work inside your own Linux container. Your persistent workspace is /workspace; the working directory for this task is ${ctx.workdir}.`,
    `Put deliverables (files the requester should receive) in ${ctx.outputDir}; they are uploaded as task artifacts when you finish.`,
    "The `agentown` CLI talks to your own organization's API as you: `agentown help` lists commands for tasks, agents and model configuration.",
    "For model/key/effort requests, use `agentown capabilities` to find configureTargets, `agentown credentials` to list approved credential IDs and models, and `agentown agent configure ID --credential ID --model MODEL --effort LEVEL`. Use credential IDs, never raw API keys.",
    "In `agentown whoami`, the `can` flags describe permissions on yourself only. A manager can configure descendants even when their own can['agent.configure'] is false. Inspect `agentown agent get ID` or capabilities.configureTargets for each target; skip agents already using the requested settings.",
    "All commands are confined to your own organization. A task's project scope does not give access to another organization or permission to change agents outside your configureTargets.",
    "The server enforces your permissions; a 403 means you are not allowed — do not try to work around it.",
    "When done, reply with a short summary of what you delivered. If you cannot proceed without someone else's input, start your final reply with BLOCKED: and say what you need.",
    ctx.config.instructions && `\nInstructions from your manager for how you work:\n${ctx.config.instructions}`,
  ]
    .filter(Boolean)
    .join("\n");
  const user = [
    `Task ${ctx.task.id}: ${ctx.task.title}`,
    ctx.task.description && `\nDescription:\n${ctx.task.description}`,
    ctx.task.acceptanceCriteria && `\nAcceptance criteria:\n${ctx.task.acceptanceCriteria}`,
    ctx.task.inputTaskIds.length ? `\nInput tasks (use \`agentown task get <id>\` and \`agentown task artifacts <id> <dir>\`): ${ctx.task.inputTaskIds.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { system, user };
}

/** Runs one bash tool call in a fresh shell in the task directory, as this agent. */
export async function runBashTool(ctx: RunContext, command: string): Promise<{ content: string; isError: boolean }> {
  ctx.setState("executing", command.slice(0, 120));
  ctx.log("agent", `$ ${command}`);
  const env = {
    AGENTOWN_TASK_ID: ctx.task.id,
    AGENTOWN_RUN_ID: ctx.runId,
    AGENTOWN_OUTPUT_DIR: ctx.outputDir,
    AGENTOWN_STATE_FILE: ctx.stateFile,
  };
  const { code, output } = await runShell(ctx, ["/bin/sh", "-c", command], env, { timeoutMs: 300_000, captureLimit: 2000 });
  let out = output.join("\n");
  if (out.length > TOOL_OUTPUT_LIMIT) out = `${out.slice(0, TOOL_OUTPUT_LIMIT)}\n[output truncated]`;
  return { content: `${out}\n[exit code ${code}]`, isError: code !== 0 };
}

export const NO_CREDENTIAL = "no API credential is configured for this agent (owner: add a key, then set it in the agent's Config tab)";
