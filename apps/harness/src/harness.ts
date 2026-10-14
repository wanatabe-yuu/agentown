import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ClaudeAdapter } from "./adapters/claude.ts";
import { OpenAICompatibleAdapter } from "./adapters/openai-compatible.ts";
import { ScriptAdapter } from "./adapters/script.ts";
import type { Adapter, RunConfig, RunContext, RunResult, TaskInfo } from "./adapters/types.ts";
import { AgentownClient, ApiError } from "./client.ts";

/**
 * Agent runtime harness. Runs inside the agent's Pod with the agent's own token.
 * It reports what it is actually doing (heartbeat + run events) and only ever
 * acts on runs leased to its own runtime generation.
 */

const env = process.env;
const agentId = env.AGENTOWN_AGENT_ID!;
const generation = Number(env.AGENTOWN_GENERATION);
const harnessKind = env.AGENTOWN_HARNESS ?? "script";
const WORKSPACE = env.AGENTOWN_WORKSPACE ?? "/workspace";
const STATE_FILE = join(env.TMPDIR ?? "/tmp", "agentown-state.json");
const HISTORY = join(WORKSPACE, "home/.agentown/history.jsonl");

const api = AgentownClient.fromEnv();
let workState: { state: string; detail: string } = { state: "idle", detail: "" };
let busy = false;
let acceptingWork = true;
let stopping = false;

function log(msg: string, extra?: unknown) {
  console.log(`[harness ${agentId} g${generation}] ${msg}`, extra ?? "");
}

function stale(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.body?.error === "stale_runtime";
}

function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  log(`stopping: ${reason}`);
  // Exit non-zero so a replaced pod that is still running crash-loops instead of acting.
  setTimeout(() => process.exit(78), 200);
}

/** Playbooks/CLI can override the reported state (e.g. "waiting" on a subtask) via a state file. */
function currentState(): { state: string; detail: string } {
  if (busy && existsSync(STATE_FILE)) {
    try {
      const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      if (typeof s.state === "string") return { state: s.state, detail: String(s.detail ?? "") };
    } catch {}
  }
  return workState;
}

async function heartbeat() {
  try {
    const s = currentState();
    const r = await api.post("/api/runtime/heartbeat", { generation, state: s.state, detail: s.detail.slice(0, 900) });
    acceptingWork = r.acceptingWork;
  } catch (err) {
    if (stale(err)) shutdown("runtime generation replaced");
    else log("heartbeat failed", String(err));
  }
}

function adapterFor(): Adapter {
  // "claude" is the LLM harness; the agent's credential decides which provider adapter runs it.
  if (harnessKind === "claude") {
    const identity = { agentId, displayName: env.AGENTOWN_DISPLAY_NAME ?? agentId, jobRole: env.AGENTOWN_JOB_ROLE ?? "agent" };
    const provider = env.AGENTOWN_LLM_PROVIDER || "anthropic";
    if (provider !== "anthropic") {
      log(`LLM harness using ${provider} at ${env.AGENTOWN_LLM_BASE_URL || "(no endpoint)"}`);
      return new OpenAICompatibleAdapter({ provider, baseUrl: env.AGENTOWN_LLM_BASE_URL ?? "", apiKey: env.AGENTOWN_LLM_API_KEY, identity });
    }
    if (!env.ANTHROPIC_API_KEY) log("claude harness without ANTHROPIC_API_KEY: prompt tasks will fail");
    return new ClaudeAdapter(env.AGENTOWN_MODEL ?? "claude-opus-5-5", identity);
  }
  return new ScriptAdapter();
}

async function uploadOutputs(runId: string, dir: string) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir).slice(0, 20)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (!st.isFile() || st.size > 2 * 1024 * 1024 || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) continue;
    const contentType = name.endsWith(".html") ? "text/html" : name.endsWith(".json") ? "application/json" : name.endsWith(".txt") || name.endsWith(".md") ? "text/plain" : "application/octet-stream";
    await api.post(`/api/runs/${runId}/artifacts`, { generation, name, contentType, contentBase64: readFileSync(path).toString("base64") });
    n++;
  }
  return n;
}

const DEFAULT_CONFIG: RunConfig = { harness: "script", provider: null, model: null, effort: null, instructions: "", maxTurns: 40, hasCredential: false };

async function execute(run: { id: string; attempt: number }, task: TaskInfo, resumed: boolean, config: RunConfig = DEFAULT_CONFIG) {
  busy = true;
  const workdir = join(WORKSPACE, "tasks", task.id);
  const outputDir = join(workdir, `out-${run.attempt}`);
  mkdirSync(outputDir, { recursive: true });
  try {
    unlinkSync(STATE_FILE);
  } catch {}
  workState = { state: "thinking", detail: task.title };
  void heartbeat();
  log(`${resumed ? "resuming" : "starting"} run ${run.id} for task ${task.id} (attempt ${run.attempt})`);

  const abort = new AbortController();
  const lines: Array<{ stream: string; line: string }> = [];
  const flush = async () => {
    if (!lines.length) return;
    const batch = lines.splice(0, 500);
    await api.post(`/api/runs/${run.id}/logs`, { generation, lines: batch }).catch((err) => {
      if (err instanceof ApiError && err.status === 409) abort.abort();
    });
  };
  const flushTimer = setInterval(() => void flush(), 1000);
  const leaseTimer = setInterval(async () => {
    try {
      await api.post(`/api/runs/${run.id}/heartbeat`, { generation });
    } catch (err) {
      // Run was cancelled/reassigned or this runtime was replaced: stop working on it.
      if (err instanceof ApiError && err.status === 409) {
        log(`lease lost for run ${run.id}: ${err.message}`);
        abort.abort();
      }
    }
  }, 15000);

  const ctx: RunContext = {
    config,
    task,
    runId: run.id,
    workdir,
    outputDir,
    stateFile: STATE_FILE,
    signal: abort.signal,
    log: (stream, line) => lines.push({ stream, line }),
    setState: (state, detail) => {
      workState = { state, detail };
    },
    event: (type, message, data) => void api.post(`/api/runs/${run.id}/events`, { generation, type, message, data }).catch(() => {}),
  };

  let result: RunResult;
  try {
    result = await adapterFor().run(ctx);
  } catch (err) {
    result = { outcome: "failed", summary: `harness error: ${(err as Error).message}` };
  }
  clearInterval(leaseTimer);
  clearInterval(flushTimer);
  await flush();

  if (!abort.signal.aborted) {
    try {
      const uploaded = await uploadOutputs(run.id, outputDir);
      const r = await api.post(`/api/runs/${run.id}/complete`, { generation, outcome: result.outcome, summary: result.summary, usage: result.usage });
      log(`run ${run.id} ${result.outcome} (${uploaded} artifacts) -> task ${r.taskStatus}`);
    } catch (err) {
      log(`could not complete run ${run.id}`, String(err));
      if (stale(err)) shutdown("runtime generation replaced");
    }
  }
  // Workspace persistence: an append-only history that survives runtime replacement.
  try {
    mkdirSync(join(WORKSPACE, "home/.agentown"), { recursive: true });
    appendFileSync(
      HISTORY,
      `${JSON.stringify({ at: new Date().toISOString(), generation, runId: run.id, taskId: task.id, outcome: result.outcome })}\n`,
    );
  } catch {}
  workState = { state: "idle", detail: "" };
  busy = false;
  void heartbeat();
}

async function loop() {
  while (!stopping) {
    if (!busy && acceptingWork) {
      try {
        const claim = await api.post("/api/runs/claim", { generation });
        if (claim) await execute(claim.run, claim.task, claim.resumed, claim.config);
      } catch (err) {
        if (stale(err)) shutdown("runtime generation replaced");
        else log("claim failed", String(err));
      }
    }
    await new Promise((r) => setTimeout(r, busy ? 1000 : 2000));
  }
}

mkdirSync(join(WORKSPACE, "home/.agentown"), { recursive: true });
const previous = existsSync(HISTORY) ? readFileSync(HISTORY, "utf8").trim().split("\n").filter(Boolean).length : 0;
log(`up (harness=${harnessKind}); workspace history has ${previous} prior runs`);
process.on("SIGTERM", () => shutdown("SIGTERM"));
await heartbeat();
// Every 5s when idle, every 2s while working (so "waiting"/"executing" show up promptly).
let ticks = 0;
setInterval(() => {
  ticks++;
  if (ticks % (busy ? 2 : 5) === 0) void heartbeat();
}, 1000);
void loop();
