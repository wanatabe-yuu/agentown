import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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
  tools                                    capabilities you may call (id, effect, approval)
  tool ID [JSON_ARGS | @FILE]              call a capability through the gateway; a call that needs
                                           approval prints {"status":"pending","proposalId":...}
                                           @FILE reads the JSON arguments from a file (large worlds)
  world                                    the current world (rooms, kinds, objects) as JSON, to
                                           write patch_world operations against (no revision needed)
  asset upload FILE [--name N]             add a PNG/JPEG/WebP texture or a GLB model to the art
                                           library (upload_asset); prints its id or a proposal
  code checkout DIR                        download this install's own source into DIR as a git
                                           repository (needs code.read on "self")
  code propose --title T [--summary S] [DIR]
                                           propose the changes in DIR (git diff against the
                                           checkout) as a patch; the owner reviews and approves,
                                           then the host builds, installs and health-checks it
  proposals [--status pending]             proposals you made or may decide
  decide ID approve|reject [--note WHY]    decide a request the owner left to you (as the lead)
  team                                     your team's channel (latest messages)
  team say TEXT                            post to your team's channel
  ask QUESTION [--option A --option B] [--timeout MINUTES] [--fallback WHAT_YOU_WILL_ASSUME]
                                           ask the person who gave you this task; then stop with
                                           BLOCKED: — the task resumes with their answer, or at the
                                           deadline (default 30 min) with leave to decide yourself
  browser list                             the world's computers (real browsers): id, state, page
  browser PC look | open URL | click REF | type [REF] TEXT [--submit] | key KEY | scroll [DY]
             | back | tab N                use computer PC; prints the page as text, with a ref
                                           (e5) on everything that can be clicked or typed into
  browser PC login WHAT [--timeout MINUTES] ask the owner to log in (WHAT: which site/account) on
                                           PC's screen; then stop with BLOCKED: — the login stays
  connector list                           outside services (MCP connectors) of this world
  connector tools ID                       a connector's tools and their input schemas
  connector call ID TOOL [JSON_ARGS | @FILE]
                                           call one; connectors set to ask wait for approval
  campaign get ID                          a campaign: goal, mode, status and its tasks (JSON)
  campaign done ID --summary S             you lead it and its goal is met: close it as achieved
  campaign fail ID --summary S             you lead it and the goal cannot be met: close it as failed
  task create --to AGENT --title T [--desc D] [--criteria C] [--project P] [--campaign ID]
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
    case "tools": {
      const r = await api.get("/api/tools");
      for (const t of r.tools) out(`${t.id}\t${t.effect}\t${t.approval}\t${t.executor}\t${t.description.slice(0, 100)}`);
      return;
    }
    case "tool": {
      if (!sub) throw new Error("tool requires a capability ID (see `agentown tools`)");
      let args: unknown = {};
      if (rest.length) {
        try {
          args = JSON.parse(rest[0]!.startsWith("@") ? readFileSync(rest[0]!.slice(1), "utf8") : rest.join(" "));
        } catch {
          throw new Error("tool arguments must be one JSON object");
        }
      }
      const r = await api.post(`/api/tools/${encodeURIComponent(sub)}/invoke`, { args });
      out(r);
      if (r?.status === "pending" && process.env.AGENTOWN_TASK_ID) {
        out(`This needs the owner's approval (proposal ${r.proposalId}). If the rest of your work depends on it, stop now with a reply starting "BLOCKED: waiting for approval"; the task resumes with the decision.`);
      }
      return;
    }
    case "decide": {
      const verdict = rest[0];
      if (!sub || (verdict !== "approve" && verdict !== "reject")) throw new Error("usage: agentown decide PROPOSAL_ID approve|reject [--note WHY]");
      const { one } = parseFlags(rest.slice(1));
      return out(await api.post(`/api/proposals/${encodeURIComponent(sub)}/decide`, { verdict, note: one("note") ?? "" }));
    }
    case "ask": {
      const { one, flags, pos } = parseFlags([sub ?? "", ...rest].filter(Boolean));
      const question = pos.join(" ").trim();
      const task = process.env.AGENTOWN_TASK_ID;
      if (!question || !task) throw new Error("usage (during a task): agentown ask QUESTION [--option A ...] [--timeout MINUTES] [--fallback TEXT]");
      const r = await api.post(`/api/tasks/${encodeURIComponent(task)}/ask`, {
        question,
        ...(flags.option?.length ? { options: flags.option } : {}),
        ...(one("timeout") ? { timeoutMinutes: Number(one("timeout")) } : {}),
        ...(one("fallback") ? { fallback: one("fallback") } : {}),
      });
      return out(`Asked (answer due by ${r.deadline}). Stop now: end your reply with a line starting "BLOCKED: waiting for the owner's answer". This task resumes with the answer, or at the deadline with leave to decide yourself.`);
    }
    case "browser":
      return browser(api, sub, rest);
    case "connector": {
      if (sub === "list") {
        const r = await api.post("/api/tools/connector_tools/invoke", { args: {} });
        for (const c of r.result.connectors) out(`${c.id}\t${c.approval}\t${c.ready ? "ready" : "no credential yet"}\t${c.name}${c.description ? ` — ${c.description}` : ""}`);
        return;
      }
      if (sub === "tools" && rest[0]) return out((await api.post("/api/tools/connector_tools/invoke", { args: { connector: rest[0] } })).result.tools);
      if (sub === "call" && rest[0] && rest[1]) {
        const raw = rest.slice(2).join(" ").trim();
        let args: unknown = {};
        try {
          args = raw ? JSON.parse(raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw) : {};
        } catch {
          throw new Error("connector call arguments must be one JSON object");
        }
        const r = await api.request("POST", "/api/tools/connector_call/invoke", { args: { connector: rest[0], tool: rest[1], arguments: args } }, false, 120_000);
        if (r.status === "pending") {
          out(`Waiting for approval (proposal ${r.proposalId}). If the rest of your work depends on it, stop now with a reply starting "BLOCKED: waiting for approval"; the task resumes with the decision and its result.`);
          return;
        }
        return out(r.result.isError ? `ERROR from ${rest[1]}:\n${r.result.text}` : r.result.structured ? r.result.structured : r.result.text);
      }
      throw new Error("usage: agentown connector list | connector tools ID | connector call ID TOOL [JSON | @FILE]");
    }
    case "campaign": {
      const id = rest[0];
      if (!id || !["get", "done", "fail"].includes(sub ?? "")) throw new Error("usage: agentown campaign get|done|fail ID [--summary S]");
      if (sub === "get") return out(await api.get(`/api/campaigns/${encodeURIComponent(id)}`));
      const { one } = parseFlags(rest.slice(1));
      if (!one("summary")) throw new Error(`campaign ${sub} requires --summary`);
      return out(await api.post(`/api/campaigns/${encodeURIComponent(id)}/finish`, { outcome: sub === "done" ? "achieved" : "failed", summary: one("summary") }));
    }
    case "world":
      return out((await api.get("/api/office/snapshot")).world ?? null);
    case "asset": {
      if (sub !== "upload" || !rest[0]) throw new Error("usage: agentown asset upload FILE [--name N]");
      const file = rest[0];
      const { one } = parseFlags(rest.slice(1));
      const content = readFileSync(file);
      // GLB files start with "glTF"; everything else is treated as an image.
      const kind = content.subarray(0, 4).toString("latin1") === "glTF" ? "model" : "texture";
      return out(await api.post("/api/tools/upload_asset/invoke", { args: { kind, name: one("name") ?? basename(file), contentBase64: content.toString("base64") } }));
    }
    case "code": {
      const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      if (sub === "checkout") {
        const dir = rest[0];
        if (!dir) throw new Error("usage: agentown code checkout DIR");
        const tgz = await api.request<Buffer>("GET", "/api/code/source", undefined, true);
        mkdirSync(dir, { recursive: true });
        execFileSync("tar", ["-xzf", "-", "-C", dir], { input: tgz });
        git(dir, "init", "-q");
        git(dir, "add", "-A");
        git(dir, "-c", "user.name=agentown", "-c", "user.email=agentown@localhost", "commit", "-qm", "checkout");
        return out(`checked out into ${dir}; edit, then: agentown code propose --title "..." ${dir}`);
      }
      if (sub === "propose") {
        const { one, pos } = parseFlags(rest);
        const dir = pos[0] ?? ".";
        const title = one("title");
        if (!title) throw new Error("code propose requires --title");
        git(dir, "add", "-A", "-N"); // new files show up in the diff too
        const diff = git(dir, "diff", "--binary", "HEAD");
        if (!diff.trim()) throw new Error("no changes to propose");
        return out(await api.post("/api/tools/propose_patch/invoke", { args: { title, summary: one("summary") ?? "", diff } }));
      }
      throw new Error("usage: agentown code checkout DIR | agentown code propose --title T [--summary S] [DIR]");
    }
    case "proposals": {
      const { one } = parseFlags([sub ?? "", ...rest].filter(Boolean));
      const r = await api.get(`/api/proposals${one("status") ? `?status=${encodeURIComponent(one("status")!)}` : ""}`);
      for (const p of r.proposals) out(`${p.id}\t${p.status}\t${p.kind}\t${p.title}`);
      return;
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

async function browser(api: AgentownClient, pc: string | undefined, rest: string[]) {
  if (pc === "list") {
    const r = await api.get("/api/computers");
    if (!r.computers.length) return out("This world has no computers.");
    for (const c of r.computers) out(`${c.id}\t${c.state}\t${c.name}${c.url ? `\t${c.title ?? ""} ${c.url}` : ""}`);
    return;
  }
  const [action, ...args] = rest;
  const { pos, one } = parseFlags(args);
  if (!pc || !action) throw new Error("usage: agentown browser list | agentown browser PC look|open|click|type|key|scroll|back|tab|login ...");
  if (action === "login") {
    const task = process.env.AGENTOWN_TASK_ID;
    const what = pos.join(" ").trim();
    if (!task || !what) throw new Error("usage (during a task): agentown browser PC login WHAT [--timeout MINUTES]");
    const r = await api.post(`/api/tasks/${encodeURIComponent(task)}/ask`, {
      question: `Please log in on computer ${pc}: ${what}`,
      computer: pc,
      options: ["Done, logged in"],
      timeoutMinutes: Number(one("timeout") ?? 60),
      fallback: "nobody logged in: carry on without that site, and say so",
    });
    return out(`Asked the owner to log in (by ${r.deadline}). Stop now: end your reply with a line starting "BLOCKED: waiting for a login on ${pc}". The task resumes when they are done.`);
  }
  const refFirst = /^e\d+$/.test(pos[0] ?? "");
  const a: Record<string, unknown> = { computer: pc, action };
  if (action === "open") a.url = pos.join(" ");
  if (action === "click") Object.assign(a, refFirst ? { ref: pos[0] } : { x: Number(pos[0]), y: Number(pos[1]) });
  if (action === "type") Object.assign(a, refFirst ? { ref: pos[0], text: pos.slice(1).join(" ") } : { text: pos.join(" ") }, one("submit") ? { submit: true } : {});
  if (action === "key") a.key = pos[0];
  if (action === "scroll" && pos[0]) a.dy = Number(pos[0]);
  if (action === "tab") a.index = Number(pos[0]);
  // A computer that is off starts on first use: that can take a minute or two.
  const r = await api.request("POST", "/api/tools/browser/invoke", { args: a }, false, 180_000);
  return out(r.result.page);
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
        campaignId: one("campaign") ?? null,
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
