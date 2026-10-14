/**
 * Runtime acceptance checks against a running server + real agent runtimes
 * (Docker driver). Run after scripts/demo.sh so the engineer/QA exist.
 *
 *   npx tsx apps/server/src/tools/verify-runtime.ts
 *
 * Checks (handoff §12): workspace survives runtime replacement; a crashed /
 * vanished runtime is replaced and its run requeued exactly once; permissions
 * hold when called from *inside* an agent runtime; agents cannot reach each
 * other over the network; a terminal is bound to actor+target and is closed
 * when the reporting line changes.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";

const ROOT = resolve(import.meta.dirname, "../../../..");
const API = process.env.AGENTOWN_API ?? "http://127.0.0.1:8080";
const OWNER = process.env.AGENTOWN_OWNER_TOKEN ?? readFileSync(resolve(ROOT, ".agentown/owner-token"), "utf8").trim();
const agentToken = (id: string) => readFileSync(resolve(ROOT, `.agentown/runtime-secrets/${id}.token`), "utf8").trim();

let passed = 0;
let failed = 0;
function check(ok: boolean, what: string, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
}

async function api(method: string, path: string, body?: unknown, token = OWNER) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 90_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(1500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const dockerTry = (...args: string[]) => {
  try {
    return { code: 0, out: execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (e: any) {
    return { code: e.status as number, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() };
  }
};

async function agent(id: string) {
  return (await api("GET", `/api/agents/${id}`)).body;
}
async function waitTask(id: string, states = ["done", "review", "failed", "blocked"]) {
  return until(`task ${id}`, async () => {
    const t = (await api("GET", `/api/tasks/${id}`)).body;
    return states.includes(t.status) ? t : null;
  });
}
async function waitReady(id: string, minGeneration: number) {
  return until(`runtime of ${id} g>=${minGeneration}`, async () => {
    const a = await agent(id);
    return a.runtime.ready && a.runtime.generation >= minGeneration && a.work.state !== "offline" ? a : null;
  });
}
async function note(agentId: string, text: string) {
  const r = await api("POST", "/api/tasks", {
    title: `note: ${text}`,
    assigneeAgentId: agentId,
    requiresReview: false,
    spec: { kind: "playbook", playbook: "workspace-note", args: { NOTE: text } },
  });
  return waitTask(r.body.task.id);
}

const agents = (await api("GET", "/api/agents")).body.agents as any[];
const eng = agents.find((a) => a.jobRole === "engineer" && a.reportsToAgentId === "lead-eng");
const qa = agents.find((a) => a.jobRole === "qa" && a.reportsToAgentId === "lead-eng");
if (!eng || !qa) throw new Error("run scripts/demo.sh first (needs the engineer and QA hired by lead-eng)");

console.log("== workspace survives runtime replacement");
const n1 = await note(eng.id, "before restart");
check(n1.status === "done", "note #1 written", n1.summary);
const g0 = (await agent(eng.id)).runtime.generation;
check((await api("POST", `/api/agents/${eng.id}/runtime/restart`)).status === 202, "owner restarts engineer runtime");
const after = await waitReady(eng.id, g0 + 1);
check(after.runtime.generation === g0 + 1, "new runtime generation", `g${g0} -> g${after.runtime.generation}`);
check(after.id === eng.id && (await api("GET", "/api/agents")).body.agents.length === agents.length, "same agent identity, no duplicate employee");
const n2 = await note(eng.id, "after restart");
check(/workspace has \d+ notes/.test(n2.summary ?? "") && Number(/has (\d+)/.exec(n2.summary)![1]) >= 2, "note #2 sees note #1 on the persisted workspace", n2.summary);

console.log("== vanished runtime: replaced, in-flight run requeued once");
const slow = await api("POST", "/api/tasks", {
  title: "slow job",
  assigneeAgentId: eng.id,
  requiresReview: false,
  spec: { kind: "script", script: "echo start; sleep 20; echo SUMMARY: slow job finished" },
});
const slowId = slow.body.task.id;
await until("slow job running", async () => (await api("GET", `/api/tasks/${slowId}`)).body.status === "in_progress");
const gBefore = (await agent(eng.id)).runtime.generation;
docker("rm", "-f", `agent-${eng.id}-g${gBefore}`);
const slowDone = await waitTask(slowId, ["done", "failed"]);
const runs = (await api("GET", `/api/tasks/${slowId}`)).body.runs as any[];
check(slowDone.status === "done", "task completed after runtime loss", slowDone.summary);
check(runs.length === 2 && runs[0].status === "lost" && runs[1].status === "succeeded", "exactly one lost run + one retry", runs.map((r) => `${r.attempt}:${r.status}@g${r.runtime_generation}`).join(" "));
check(runs[1].runtime_generation > gBefore, "retry ran on the replacement runtime");

console.log("== permissions hold inside the runtime (agent's own token)");
const inEng = (cmd: string) => dockerTry("exec", `agent-${eng.id}-g${(execFileSync("docker", ["ps", "--filter", `label=agentown.io/agent=${eng.id}`, "--format", "{{.Label \"agentown.io/generation\"}}"], { encoding: "utf8" }).trim())}`, "sh", "-c", cmd);
let r = inEng("agentown spawn --template engineer-v1 --name Rogue");
check(r.code === 13 && /403/.test(r.out), "engineer cannot spawn", r.out);
r = inEng("agentown task create --to ceo --title 'do my work'");
check(r.code === 13, "engineer cannot assign work to the CEO", r.out);
r = inEng(`agentown task get ${slowDone.parentTaskId ?? n1.id}`);
check(r.code === 0, "engineer can read its own task");
r = inEng("agentown agents | wc -l");
check(r.out.trim() === "1", "engineer sees only itself in the org", r.out);
r = inEng("id -u; test -e /var/run/secrets/kubernetes.io && echo k8s-token || echo no-k8s-token; test -S /var/run/docker.sock && echo docker-sock || echo no-docker-sock; touch /etc/x 2>/dev/null && echo rootfs-rw || echo rootfs-ro");
check(r.out === "1000\nno-k8s-token\nno-docker-sock\nrootfs-ro", "runtime is non-root, read-only, no cluster/Docker credentials", r.out.replace(/\n/g, ","));

console.log("== network isolation between agents");
const qaGen = (await agent(qa.id)).runtime.generation;
const qaIp = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", `agent-${qa.id}-g${qaGen}`);
const listener = dockerTry("exec", "-d", `agent-${qa.id}-g${qaGen}`, "sh", "-c", "nc -lk -p 9000 -e echo hi");
check(listener.code === 0, "QA listens on :9000 (test listener)");
await sleep(500);
const local = dockerTry("exec", `agent-${qa.id}-g${qaGen}`, "sh", "-c", "echo | nc -w 2 127.0.0.1 9000");
check(/hi/.test(local.out), "listener reachable locally (control)", local.out);
r = inEng(`echo | nc -w 3 ${qaIp} 9000 && echo CONNECTED || echo BLOCKED`);
check(/BLOCKED/.test(r.out) && !/hi/.test(r.out), "engineer cannot reach QA in the same department", r.out.replace(/\n/g, ","));

console.log("== terminal bound to actor + target, closed when the reporting line changes");
const leadToken = agentToken("lead-eng");
const denied = await api("POST", `/api/agents/${eng.id}/terminal-sessions`, {}, agentToken("lead-ops"));
check(denied.status === 403, "leader B cannot open a terminal on leader A's engineer");
const ts = await api("POST", `/api/agents/${eng.id}/terminal-sessions`, {}, leadToken);
check(ts.status === 201, "leader A opens a terminal on its engineer");
const ws = new WebSocket(`${API.replace("http", "ws")}/api/terminal-sessions/${ts.body.sessionId}/attach?ticket=${ts.body.ticket}`);
let output = "";
let exitReason = "";
ws.on("message", (m) => {
  const msg = JSON.parse(m.toString());
  if (msg.type === "output") output += msg.data;
  if (msg.type === "exit") exitReason = msg.reason;
});
await new Promise((res) => ws.on("open", res));
await sleep(800);
ws.send(JSON.stringify({ type: "input", data: "echo whoami=$(id -u)@$(hostname)\n" }));
await until("terminal output", async () => output.includes(`whoami=1000@${eng.id}`), 15_000);
check(true, "shell runs as the engineer's runtime user");
const reuse = new WebSocket(`${API.replace("http", "ws")}/api/terminal-sessions/${ts.body.sessionId}/attach?ticket=${ts.body.ticket}`);
const reuseMsg = await new Promise<string>((res) => reuse.on("message", (m) => res(m.toString())));
check(/invalid or expired/.test(reuseMsg), "ticket cannot be replayed");
check((await api("PATCH", `/api/agents/${eng.id}`, { reportsToAgentId: "lead-ops" })).status === 200, "owner moves the engineer to leader B");
await until("terminal closed", async () => exitReason, 15_000);
check(/exec permission no longer held/.test(exitReason), "open terminal was closed by the server", exitReason);
check((await api("POST", `/api/agents/${eng.id}/terminal-sessions`, {}, leadToken)).status === 403, "leader A can no longer open one");
await api("PATCH", `/api/agents/${eng.id}`, { reportsToAgentId: "lead-eng" });

console.log("== audit");
const audit = (await api("GET", "/api/audit")).body.events as any[];
check(audit.some((e) => e.action === "terminal.open" && !e.allowed && e.actor === "agent:lead-ops"), "denied terminal is in the audit log");
check(audit.some((e) => e.action === "agent.spawn" && !e.allowed && e.actor === `agent:${eng.id}`), "denied spawn from inside the runtime is in the audit log");
check(!JSON.stringify(audit).includes(leadToken), "audit never contains agent tokens");

console.log(`\npassed: ${passed}  failed: ${failed}`);
process.exit(failed ? 1 : 0);
