import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Adapter, RunContext, RunResult } from "./types.ts";

const PLAYBOOK_DIR = process.env.AGENTOWN_PLAYBOOK_DIR ?? "/opt/agentown/playbooks";
const EXIT_BLOCKED = 3;

/** Run a shell command for a task, streaming its output to the work log. */
export function runShell(
  ctx: RunContext,
  argv: string[],
  extraEnv: Record<string, string>,
  opts: { timeoutMs?: number; captureLimit?: number } = {},
): Promise<{ code: number; output: string[] }> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      // Provider credentials are for the LLM adapter only, never for task processes.
      if (v !== undefined && k !== "ANTHROPIC_API_KEY") env[k] = v;
    }
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: ctx.workdir,
      env: { ...env, ...extraEnv },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: string[] = [];
    const keep = opts.captureLimit ?? 200;
    const onLine = (stream: "stdout" | "stderr") => (line: string) => {
      ctx.log(stream, line);
      output.push(line);
      if (output.length > keep) output.shift();
    };
    createInterface({ input: child.stdout! }).on("line", onLine("stdout"));
    createInterface({ input: child.stderr! }).on("line", onLine("stderr"));
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    };
    ctx.signal.addEventListener("abort", kill, { once: true });
    const timer = opts.timeoutMs ? setTimeout(kill, opts.timeoutMs) : null;
    child.on("close", (code, sig) => {
      if (timer) clearTimeout(timer);
      ctx.signal.removeEventListener("abort", kill);
      resolve({ code: code ?? (sig ? 137 : 1), output });
    });
  });
}

/**
 * Deterministic adapter: no model involved. Runs an owner-approved playbook
 * baked into the image (args as ARG_* env vars) or an inline script (which the
 * server only accepts from someone holding runtime.exec on this agent).
 */
export class ScriptAdapter implements Adapter {
  async run(ctx: RunContext): Promise<RunResult> {
    const { spec } = ctx.task;
    let argv: string[];
    const env: Record<string, string> = {
      AGENTOWN_TASK_ID: ctx.task.id,
      AGENTOWN_RUN_ID: ctx.runId,
      AGENTOWN_OUTPUT_DIR: ctx.outputDir,
      AGENTOWN_STATE_FILE: ctx.stateFile,
      AGENTOWN_INPUT_TASK_IDS: ctx.task.inputTaskIds.join(" "),
      AGENTOWN_TASK_TITLE: ctx.task.title,
    };
    if (spec.kind === "playbook") {
      const path = `${PLAYBOOK_DIR}/${spec.playbook}.sh`;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(spec.playbook) || !existsSync(path)) {
        return { outcome: "failed", summary: `unknown playbook ${spec.playbook}` };
      }
      for (const [k, v] of Object.entries(spec.args ?? {})) env[`ARG_${k}`] = v;
      argv = ["/bin/sh", path];
    } else if (spec.kind === "script") {
      argv = ["/bin/sh", "-c", spec.script];
    } else {
      return {
        outcome: "blocked",
        summary: "this runtime uses the deterministic script harness and cannot work on free-form prompt tasks; assign it to an agent with an LLM harness",
      };
    }
    ctx.setState("executing", spec.kind === "playbook" ? `playbook ${spec.playbook}` : "script");
    const { code, output } = await runShell(ctx, argv, env);
    const summaryLine = [...output].reverse().find((l) => l.startsWith("SUMMARY:"));
    const summary = summaryLine ? summaryLine.slice(8).trim() : output.slice(-5).join("\n");
    if (code === 0) return { outcome: "succeeded", summary };
    if (code === EXIT_BLOCKED) return { outcome: "blocked", summary: summary || "blocked" };
    return { outcome: "failed", summary: `exit ${code}: ${summary}` };
  }
}
