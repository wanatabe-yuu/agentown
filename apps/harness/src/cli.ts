import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentownClient, ApiError } from "./client.ts";

/**
 * `agentown` — the agent's tool for talking to its organization. Runs with the
 * agent's own token; the server decides what is allowed.
 */

const HELP = `agentown <command>

  whoami                                   show this agent's identity
  agents                                   list agents you are allowed to see
  spawn --template T --name N [--manager M] [--key K]
                                           hire a new agent from an approved template
  task create --to AGENT --title T [--desc D] [--criteria C] [--project P]
              [--playbook NAME --arg KEY=VALUE ...] [--input TASK_ID ...] [--key K]
                                           create a task (parent = current task)
  task get ID                              show a task (JSON)
  task list                                tasks you can see
  task wait ID [--timeout SECONDS]         wait until a task finishes; exit 0 if done
  task artifacts ID DIR                    download a task's artifacts into DIR
  task review ID approve|reject [--note N] review a task in review
  state STATE [DETAIL]                     report work state (thinking|executing|waiting|blocked)
`;

function parseFlags(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "true";
      (flags[k] ??= []).push(v);
    } else pos.push(a);
  }
  const one = (k: string) => flags[k]?.[0];
  return { pos, flags, one };
}

function setState(state: string, detail: string) {
  const f = process.env.AGENTOWN_STATE_FILE;
  if (f) writeFileSync(f, JSON.stringify({ state, detail }));
}

const out = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") return out(HELP);
  if (cmd === "state") {
    setState(sub ?? "executing", rest.join(" "));
    return;
  }
  const api = AgentownClient.fromEnv();

  switch (cmd) {
    case "whoami":
      return out(await api.get(`/api/agents/${process.env.AGENTOWN_AGENT_ID}`));
    case "agents": {
      const r = await api.get("/api/agents");
      for (const a of r.agents) out(`${a.id}\t${a.displayName}\t${a.jobRole}\t${a.departmentId}\treports-to=${a.reportsToAgentId ?? "-"}\t${a.work.state}`);
      return;
    }
    case "spawn": {
      const { one } = parseFlags([sub ?? "", ...rest].filter(Boolean));
      const r = await api.post("/api/agents", {
        templateId: one("template"),
        displayName: one("name"),
        reportsToAgentId: one("manager") ?? process.env.AGENTOWN_AGENT_ID,
        idempotencyKey: one("key"),
      });
      return out(r.agent.id);
    }
    case "task":
      return task(api, sub, rest);
    default:
      throw new Error(`unknown command ${cmd}\n${HELP}`);
  }
}

async function task(api: AgentownClient, sub: string | undefined, rest: string[]) {
  const { pos, flags, one } = parseFlags(rest);
  switch (sub) {
    case "create": {
      const args: Record<string, string> = {};
      for (const kv of flags.arg ?? []) {
        const i = kv.indexOf("=");
        if (i > 0) args[kv.slice(0, i)] = kv.slice(i + 1);
      }
      const playbook = one("playbook");
      const r = await api.post("/api/tasks", {
        title: one("title"),
        description: one("desc"),
        acceptanceCriteria: one("criteria"),
        assigneeAgentId: one("to"),
        projectId: one("project") ?? null,
        parentTaskId: one("parent") ?? process.env.AGENTOWN_TASK_ID ?? null,
        inputTaskIds: flags.input ?? [],
        spec: playbook ? { kind: "playbook", playbook, args } : { kind: "prompt" },
        idempotencyKey: one("key"),
      });
      return out(r.task.id);
    }
    case "get":
      return out(await api.get(`/api/tasks/${pos[0]}`));
    case "list": {
      const r = await api.get("/api/tasks");
      for (const t of r.tasks) out(`${t.id}\t${t.status}\t${t.assigneeAgentId ?? "-"}\t${t.title}`);
      return;
    }
    case "wait": {
      const id = pos[0]!;
      const deadline = Date.now() + Number(one("timeout") ?? 1800) * 1000;
      setState("waiting", `waiting for ${id}`);
      try {
        while (Date.now() < deadline) {
          const t = await api.get(`/api/tasks/${id}`);
          if (["done", "review"].includes(t.status)) {
            out(`${id} ${t.status}: ${t.summary ?? ""}`);
            return;
          }
          if (["failed", "cancelled", "blocked"].includes(t.status)) {
            out(`${id} ${t.status}: ${t.statusReason ?? t.summary ?? ""}`);
            process.exitCode = 1;
            return;
          }
          await sleep(2000);
        }
        out(`${id}: timed out`);
        process.exitCode = 2;
      } finally {
        setState("executing", "");
      }
      return;
    }
    case "artifacts": {
      const [id, dir] = pos;
      const t = await api.get(`/api/tasks/${id}`);
      mkdirSync(dir!, { recursive: true });
      for (const a of t.artifacts) {
        const buf = await api.request<Buffer>("GET", `/api/artifacts/${a.id}`, undefined, true);
        writeFileSync(join(dir!, a.name), buf);
        out(`${a.name}\t${a.size}\t${a.sha256}`);
      }
      return;
    }
    case "review": {
      const [id, decision] = pos;
      return out(await api.post(`/api/tasks/${id}/review`, { decision, note: one("note") ?? "" }));
    }
    default:
      throw new Error(`unknown task command ${sub}\n${HELP}`);
  }
}

main().catch((err) => {
  if (err instanceof ApiError) console.error(`agentown: ${err.status} ${err.body?.message ?? ""}`);
  else console.error(`agentown: ${(err as Error).message}`);
  process.exit(err instanceof ApiError && err.status === 403 ? 13 : 1);
});
