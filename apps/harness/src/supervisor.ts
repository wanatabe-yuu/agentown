import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { apiProtocol } from "@agentown/core";
import { AgentownClient, ApiError } from "./client.ts";

/**
 * Team runtime supervisor. One runtime per team: every member runs as its own
 * process with its own session token, home, memory and model connection, in the
 * team's shared environment. Members come and go without restarting the runtime;
 * only a resize or preset change replaces it (a new team generation).
 */

interface Member {
  id: string;
  displayName: string;
  jobRole: string;
  generation: number;
  harness: string;
  model: string | null;
  llm: { provider: string; protocol?: string } | null;
}
interface Hello {
  team: { id: string; name: string; department: string };
  generation: number;
  members: Member[];
}

const env = process.env;
const teamId = env.AGENTOWN_TEAM_ID!;
const teamGeneration = Number(env.AGENTOWN_TEAM_GENERATION);
const apiUrl = env.AGENTOWN_API_URL!.replace(/\/$/, "");
const ROOT = env.AGENTOWN_WORKSPACE ?? "/workspace";
const api = AgentownClient.fromEnv();
const children = new Map<string, { proc: ChildProcess; generation: number; exited: boolean; exitedAt: number }>();
let stopping = false;

function log(msg: string, extra?: unknown) {
  console.log(`[team ${teamId} g${teamGeneration}] ${msg}`, extra ?? "");
}

/** Non-secret broker settings for one member's model connection (keys stay on the server). */
function llmEnv(llm: Member["llm"]): Record<string, string> {
  if (!llm) return {};
  const protocol = apiProtocol(llm.provider, llm.protocol as "anthropic" | "openai" | undefined);
  const broker = `${apiUrl}/api/runtime/llm/${protocol}`;
  return {
    AGENTOWN_LLM_PROVIDER: llm.provider,
    AGENTOWN_LLM_PROTOCOL: protocol,
    AGENTOWN_LLM_BROKER: "1",
    ...(protocol === "anthropic" ? { ANTHROPIC_BASE_URL: broker } : { AGENTOWN_LLM_BASE_URL: `${broker}/v1` }),
  };
}

async function start(m: Member, team: Hello["team"]) {
  const session = await api.post<{ token: string; generation: number }>(`/api/runtime/team/members/${m.id}/session`);
  const home = join(ROOT, "members", m.id);
  const tmp = join(env.TMPDIR ?? "/tmp", "members", m.id);
  mkdirSync(join(home, "home"), { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const childEnv: Record<string, string> = {
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    AGENTOWN_API_URL: apiUrl,
    AGENTOWN_TOKEN: session.token,
    AGENTOWN_AGENT_ID: m.id,
    AGENTOWN_GENERATION: String(session.generation),
    AGENTOWN_HARNESS: m.harness,
    AGENTOWN_DISPLAY_NAME: m.displayName,
    AGENTOWN_JOB_ROLE: m.jobRole,
    AGENTOWN_TEAM_ID: team.id,
    AGENTOWN_TEAM_NAME: team.name,
    AGENTOWN_WORKSPACE: home,
    AGENTOWN_SHARED: join(ROOT, "shared"),
    HOME: join(home, "home"),
    TMPDIR: tmp,
    ...(m.model ? { AGENTOWN_MODEL: m.model } : {}),
    ...llmEnv(m.llm),
  };
  const proc = spawn(process.execPath, [process.argv[1]!], { env: childEnv, stdio: "inherit", cwd: home });
  const entry = { proc, generation: session.generation, exited: false, exitedAt: 0 };
  children.set(m.id, entry);
  proc.on("exit", (code) => {
    entry.exited = true;
    entry.exitedAt = Date.now();
    log(`member ${m.id} exited (${code})`);
  });
  log(`member ${m.id} (${m.displayName}) started at generation ${session.generation}`);
}

function stop(id: string, why: string) {
  const c = children.get(id);
  if (!c) return;
  if (!c.exited) {
    log(`stopping member ${id}: ${why}`);
    c.proc.kill("SIGTERM");
  }
  children.delete(id);
}

async function tick() {
  let hello: Hello;
  try {
    hello = await api.get<Hello>("/api/runtime/team");
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 404)) return shutdown(`runtime credential rejected (${err.status})`);
    return log("team hello failed", String(err));
  }
  if (hello.generation !== teamGeneration) return shutdown(`team runtime replaced (generation ${hello.generation})`);
  const wanted = new Map(hello.members.map((m) => [m.id, m]));
  for (const id of [...children.keys()]) if (!wanted.has(id)) stop(id, "no longer a running member of this team");
  for (const m of hello.members) {
    const c = children.get(m.id);
    if (c && !c.exited && c.generation !== m.generation) stop(m.id, `member generation ${c.generation} -> ${m.generation}`);
    const cur = children.get(m.id);
    if (cur && !(cur.exited && Date.now() - cur.exitedAt > 3000)) continue;
    children.delete(m.id);
    await start(m, hello.team).catch((err) => log(`could not start member ${m.id}`, String(err)));
  }
}

function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  log(`stopping: ${reason}`);
  for (const id of [...children.keys()]) stop(id, reason);
  // Non-zero: a replaced runtime that is still running crash-loops instead of acting.
  setTimeout(() => process.exit(78), 500);
}

mkdirSync(join(ROOT, "shared"), { recursive: true });
mkdirSync(join(ROOT, "members"), { recursive: true });
process.on("SIGTERM", () => shutdown("SIGTERM"));
log("team runtime up");
while (!stopping) {
  await tick();
  await new Promise((r) => setTimeout(r, 5000));
}
