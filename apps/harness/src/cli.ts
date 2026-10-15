import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentownClient, ApiError } from "./client.ts";

/**
 * `agentown` — the agent's tool for talking to its organization. Runs with the
 * agent's own token; the server decides what is allowed.
 */

const HELP = `agentown <command>

  whoami                                   identity and permissions (can = on yourself only)
  capabilities                             permitted task/configuration targets in this organization
  agents                                   list agents you are allowed to see
  agent get ID                             inspect an agent and your permissions on it
  credentials                              list available credential IDs and models (never API keys)
  agent configure ID [--credential ID] [--model MODEL] [--effort LEVEL]
                     [--instructions TEXT] [--max-turns N] [--context-limit TOKENS]
                                           configure an agent you are allowed to manage
                                           use "none" to clear credential, model or effort
  spawn --template T --name N [--manager M] [--team TEAM] [--cpu 100m] [--memory 192Mi] [--key K]
                                           hire a new agent from an approved template; it joins
                                           TEAM's runtime and adds the declared cpu/memory to it
  team                                     your team's channel (latest messages)
  team say TEXT                            post to your team's channel
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
      const v = argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "true";
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
    case "whoami": {
      const identity = await api.get(`/api/agents/${process.env.AGENTOWN_AGENT_ID}`);
      return out({ ...identity, capabilities: await api.get("/api/capabilities") });
    }
    case "capabilities":
      return out(await api.get("/api/capabilities"));
    case "credentials":
      return out(await api.get("/api/credentials"));
    case "agent":
      return agent(api, sub, rest);
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
        ...(one("team") ? { teamId: one("team") } : {}),
        ...(one("cpu") || one("memory") ? { resources: { ...(one("cpu") ? { cpu: one("cpu") } : {}), ...(one("memory") ? { memory: one("memory") } : {}) } } : {}),
        idempotencyKey: one("key"),
      });
      return out(r.agent.id);
    }
    case "team": {
      const me = await api.get(`/api/agents/${process.env.AGENTOWN_AGENT_ID}`);
      const path = `/api/teams/${encodeURIComponent(me.teamId)}/messages`;
      if (sub === "say") {
        const text = rest.join(" ").trim();
        if (!text) throw new Error("team say requires a message");
        return out(await api.post(path, { text }));
      }
      if (sub) throw new Error(`unknown team command ${sub}\n${HELP}`);
      const r = await api.get(path);
      for (const m of r.messages.slice(-50)) out(`${m.at}\t${m.author.name}${m.system ? " (activity)" : ""}: ${m.text}`);
      return;
    }
    case "task":
      return task(api, sub, rest);
    default:
      throw new Error(`unknown command ${cmd}\n${HELP}`);
  }
}

async function agent(api: AgentownClient, sub: string | undefined, rest: string[]) {
  const { pos, flags, one } = parseFlags(rest);
  const id = pos[0];
  if (!id || pos.length !== 1) throw new Error(`agent ${sub} requires one agent ID`);
  const path = `/api/agents/${encodeURIComponent(id)}`;
  if (sub === "get") return out(await api.get(path));
  if (sub !== "configure") throw new Error(`unknown agent command ${sub}\n${HELP}`);
  const fields = { credential: "credentialId", model: "model", effort: "effort", instructions: "instructions", "max-turns": "maxTurns", "context-limit": "contextLimit" } as const;
  const change: Record<string, unknown> = {};
  for (const flag of Object.keys(flags)) {
    if (!Object.hasOwn(fields, flag)) throw new Error(`unknown configuration flag --${flag}`);
    const value = one(flag)!;
    if (value === "true" || flags[flag]!.length !== 1) throw new Error(`--${flag} requires one value`);
    const field = fields[flag as keyof typeof fields];
    change[field] = ["maxTurns", "contextLimit"].includes(field) && value !== "none" ? Number(value)
      : value === "none" && ["credentialId", "model", "effort", "contextLimit"].includes(field) ? null : value;
  }
  if (!Object.keys(change).length) throw new Error("agent configure requires at least one configuration flag");
  return out(await api.put(`${path}/config`, change));
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
