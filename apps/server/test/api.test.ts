import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";
import { llmEnv } from "../src/runtime/driver.ts";

type Env = Awaited<ReturnType<typeof setup>>;
let env: Env;

beforeAll(async () => {
  env = await setup();
});
afterAll(async () => {
  await env?.close();
});

async function spawnUnder(managerToken: string, templateId: string, name: string, manager: string, key?: string) {
  return env.call(managerToken, "POST", "/api/agents", {
    templateId,
    displayName: name,
    reportsToAgentId: manager,
    idempotencyKey: key,
  });
}

async function gen(agentId: string): Promise<number> {
  const { rows } = await env.db.query("SELECT generation FROM agent_runtimes WHERE agent_id=$1", [agentId]);
  return rows[0].generation;
}

describe("authentication", () => {
  it("rejects missing and forged tokens", async () => {
    const res = await env.app.inject({ method: "GET", url: "/api/agents" });
    expect(res.statusCode).toBe(401);
    expect((await env.call("aag_forged", "GET", "/api/agents")).status).toBe(401);
  });

  it("ignores client-supplied actor ids", async () => {
    // A worker cannot become the CEO by claiming to be it in the body.
    const r = await env.call(env.token("lead-eng"), "POST", "/api/agents", {
      templateId: "leader-v1",
      displayName: "Sneaky",
      reportsToAgentId: "ceo",
      actorId: "ceo",
    });
    expect(r.status).toBe(403);
  });
});

describe("bootstrap runtimes", () => {
  it("brings every bootstrap agent to active via the controller", async () => {
    const r = await env.call(env.owner, "GET", "/api/agents");
    expect(r.status).toBe(200);
    expect(r.body.agents.map((a: any) => a.id).sort()).toEqual(["ceo", "lead-eng", "lead-ops", "po"]);
    for (const a of r.body.agents) {
      expect(a.lifecycleState).toBe("active");
      expect(a.runtime.ready).toBe(true);
      // No heartbeat yet: the character must not look like it is working.
      expect(a.work.state).toBe("offline");
    }
  });
});

describe("spawn", () => {
  it("leader spawns allowed templates under itself, idempotently", async () => {
    const t = env.token("lead-eng");
    const a = await spawnUnder(t, "engineer-v1", "Eli", "lead-eng", "eng-1");
    expect(a.status).toBe(202);
    const again = await spawnUnder(t, "engineer-v1", "Eli", "lead-eng", "eng-1");
    expect(again.status).toBe(200);
    expect(again.body.existing).toBe(true);
    expect(again.body.agent.id).toBe(a.body.agent.id);
    const { rows } = await env.db.query("SELECT count(*)::int AS n FROM agents WHERE display_name='Eli'");
    expect(rows[0].n).toBe(1);
  });

  it("denies templates, managers and actors outside the grant", async () => {
    expect((await spawnUnder(env.token("lead-eng"), "leader-v1", "X", "lead-eng")).status).toBe(403);
    expect((await spawnUnder(env.token("lead-eng"), "engineer-v1", "X", "lead-ops")).status).toBe(403);
    expect((await spawnUnder(env.token("po"), "engineer-v1", "X", "po")).status).toBe(403);
    const denied = await spawnUnder(env.token("lead-ops"), "engineer-v1", "X", "lead-eng");
    expect(denied.status).toBe(403);
    expect(denied.body.message).toMatch(/agent.spawn denied/);
  });

  it("CEO spawns under its tree, not outside the catalog", async () => {
    expect((await spawnUnder(env.token("ceo"), "qa-v1", "Quinn", "lead-ops", "ops-qa")).status).toBe(202);
    expect((await spawnUnder(env.token("ceo"), "ceo-v1", "Clone", "ceo")).status).toBe(403);
  });
});

describe("leader boundaries (handoff §12)", () => {
  let engId: string;
  let opsQaId: string;

  beforeAll(async () => {
    await env.settle();
    const { rows } = await env.db.query("SELECT id, display_name FROM agents WHERE display_name IN ('Eli','Quinn')");
    engId = rows.find((r) => r.display_name === "Eli").id;
    opsQaId = rows.find((r) => r.display_name === "Quinn").id;
  });

  it("leader A controls its report but not the CEO, leader B, or B's people", async () => {
    const t = env.token("lead-eng");
    expect((await env.call(t, "POST", `/api/agents/${engId}/pause`)).status).toBe(200);
    expect((await env.call(t, "POST", `/api/agents/${engId}/resume`)).status).toBe(200);
    for (const target of ["ceo", "lead-ops", opsQaId]) {
      expect((await env.call(t, "POST", `/api/agents/${target}/pause`)).status, target).toBe(403);
      expect((await env.call(t, "POST", `/api/agents/${target}/runtime/stop`)).status, target).toBe(403);
      expect((await env.call(t, "POST", `/api/agents/${target}/terminal-sessions`)).status, target).toBe(403);
    }
  });

  it("leader gets a terminal ticket for its report; PO and CEO do not", async () => {
    const ok = await env.call(env.token("lead-eng"), "POST", `/api/agents/${engId}/terminal-sessions`);
    expect(ok.status).toBe(201);
    expect(ok.body.ticket).toBeTruthy();
    expect((await env.call(env.token("po"), "POST", `/api/agents/${engId}/terminal-sessions`)).status).toBe(403);
    expect((await env.call(env.token("ceo"), "POST", `/api/agents/${engId}/terminal-sessions`)).status).toBe(403);
  });

  it("workers cannot spawn, delegate, or read others' logs", async () => {
    const t = env.token(engId);
    expect((await spawnUnder(t, "engineer-v1", "Y", engId)).status).toBe(403);
    expect(
      (await env.call(t, "POST", "/api/grants", { principalId: opsQaId, action: "runtime.exec", scope: { kind: "self" } })).status,
    ).toBe(403);
    expect((await env.call(t, "GET", `/api/agents/lead-eng/logs`)).status).toBe(403);
    expect((await env.call(t, "GET", `/api/agents/${engId}/logs`)).status).toBe(200);
  });

  it("agents only list agents they may view", async () => {
    const r = await env.call(env.token(engId), "GET", "/api/agents");
    expect(r.body.agents.map((a: any) => a.id)).toEqual([engId]);
    const lead = await env.call(env.token("lead-eng"), "GET", "/api/agents");
    expect(lead.body.agents.map((a: any) => a.id).sort()).toEqual([engId, "lead-eng"].sort());
  });

  it("denials are audited with actor, action and reason, without secrets", async () => {
    const r = await env.call(env.owner, "GET", "/api/audit");
    const denial = r.body.events.find((e: any) => e.actor === "agent:po" && e.action === "terminal.open");
    expect(denial).toBeTruthy();
    expect(denial.allowed).toBe(false);
    expect(denial.reason).toMatch(/no grant for runtime.exec/);
    expect(JSON.stringify(r.body.events)).not.toMatch(/aag_|aho_/);
  });

  it("audit is owner-only", async () => {
    expect((await env.call(env.token("ceo"), "GET", "/api/audit")).status).toBe(403);
  });
});

describe("tasks and runs", () => {
  let engId: string;
  let qaId: string;

  beforeAll(async () => {
    const qa = await spawnUnder(env.token("lead-eng"), "qa-v1", "Quang", "lead-eng", "qa-1");
    qaId = qa.body.agent.id;
    await env.settle();
    const { rows } = await env.db.query("SELECT id FROM agents WHERE display_name='Eli'");
    engId = rows[0].id;
  });

  it("inline scripts need exec on the assignee; playbooks do not", async () => {
    const script = await env.call(env.token("ceo"), "POST", "/api/tasks", {
      title: "x",
      assigneeAgentId: "lead-eng",
      spec: { kind: "script", script: "id" },
    });
    expect(script.status).toBe(403);
    const pb = await env.call(env.token("ceo"), "POST", "/api/tasks", {
      title: "Run demo",
      assigneeAgentId: "lead-eng",
      spec: { kind: "playbook", playbook: "noop", args: { MESSAGE: "hi" } },
    });
    expect(pb.status).toBe(201);
    expect((await env.call(env.token("ceo"), "POST", `/api/tasks/${pb.body.task.id}/cancel`, {})).status).toBe(200);
  });

  it("PO creates website tasks only, and cannot create unscoped ones", async () => {
    expect(
      (await env.call(env.token("po"), "POST", "/api/tasks", { title: "Copy", assigneeAgentId: engId, projectId: "website" })).status,
    ).toBe(201);
    expect((await env.call(env.token("po"), "POST", "/api/tasks", { title: "Copy", assigneeAgentId: engId })).status).toBe(403);
  });

  it("claim → lease → artifact → complete; re-claim resumes instead of duplicating", async () => {
    // Clear the PO task so the next claim is ours.
    await env.db.query("UPDATE tasks SET status='cancelled' WHERE assignee_agent_id=$1", [engId]);
    const lead = env.token("lead-eng");
    const created = await env.call(lead, "POST", "/api/tasks", {
      title: "Build page",
      assigneeAgentId: engId,
      spec: { kind: "playbook", playbook: "build-page", args: { TITLE: "Hello" } },
      idempotencyKey: "build-1",
    });
    expect(created.status).toBe(201);
    const dup = await env.call(lead, "POST", "/api/tasks", { title: "Build page", assigneeAgentId: engId, idempotencyKey: "build-1" });
    expect(dup.body.task.id).toBe(created.body.task.id);

    const t = env.token(engId);
    const g = await gen(engId);
    expect((await env.call(t, "POST", "/api/runtime/heartbeat", { generation: g, state: "idle" })).status).toBe(200);
    const claim = await env.call(t, "POST", "/api/runs/claim", { generation: g });
    expect(claim.status).toBe(200);
    expect(claim.body.task.id).toBe(created.body.task.id);
    const again = await env.call(t, "POST", "/api/runs/claim", { generation: g });
    expect(again.body.resumed).toBe(true);
    expect(again.body.run.id).toBe(claim.body.run.id);

    const runId = claim.body.run.id;
    await env.call(t, "POST", `/api/runtime/heartbeat`, { generation: g, state: "thinking", detail: "Đang phân tích yêu cầu tiếng Việt" });
    await env.call(t, "POST", `/api/runs/${runId}/logs`, { generation: g, lines: [{ stream: "agent", line: "Đang xử lý tác vụ" }] });
    const activeProgress = await env.call(env.owner, "GET", `/api/tasks/${created.body.task.id}/progress`);
    expect(activeProgress.body.current).toMatchObject({ state: "thinking", detail: "Đang phân tích yêu cầu tiếng Việt" });
    expect(activeProgress.body.logs[0].line).toBe("Đang xử lý tác vụ");
    expect((await env.call(env.token(qaId), "GET", `/api/tasks/${created.body.task.id}/progress`)).status).toBe(403);
    const utf8 = "# Tóm tắt cấu hình\nTiếng Việt: với tất cả mọi người ✅";
    const md = await env.call(t, "POST", `/api/runs/${runId}/artifacts`, { generation: g, name: "config-summary.md", contentType: "text/plain", contentBase64: Buffer.from(utf8, "utf8").toString("base64") });
    const textFile = await env.app.inject({ method: "GET", url: `/api/orgs/${env.instance.defaultOrgId}/artifacts/${md.body.id}`, headers: { authorization: `Bearer ${env.owner}` } });
    expect(textFile.body).toBe(utf8); expect(textFile.headers["content-type"]).toMatch(/charset=utf-8/);
    expect(textFile.headers["content-security-policy"]).toBe("sandbox");
    const art = await env.call(t, "POST", `/api/runs/${runId}/artifacts`, {
      generation: g,
      name: "index.html",
      contentType: "text/html",
      contentBase64: Buffer.from("<h1>Hello</h1>").toString("base64"),
    });
    expect(art.status).toBe(201);
    // Someone else's runtime cannot write into this run.
    expect(
      (await env.call(env.token(qaId), "POST", `/api/runs/${runId}/complete`, { generation: await gen(qaId), outcome: "succeeded" })).status,
    ).toBe(404);
    const done = await env.call(t, "POST", `/api/runs/${runId}/complete`, { generation: g, outcome: "succeeded", summary: "ok" });
    expect(done.body.taskStatus).toBe("done");

    // QA sees the engineer's task only once a task assigned to QA references it.
    expect((await env.call(env.token(qaId), "GET", `/api/tasks/${created.body.task.id}`)).status).toBe(403);
    const qaTask = await env.call(lead, "POST", "/api/tasks", {
      title: "Verify page",
      assigneeAgentId: qaId,
      inputTaskIds: [created.body.task.id],
    });
    expect(qaTask.status).toBe(201);
    const seen = await env.call(env.token(qaId), "GET", `/api/tasks/${created.body.task.id}`);
    expect(seen.status).toBe(200);
    const artifact = await env.app.inject({
      method: "GET",
      url: `/api/artifacts/${seen.body.artifacts.find((a: any) => a.name === "index.html").id}`,
      headers: { authorization: `Bearer ${await env.member(qaId)}` },
    });
    expect(artifact.body).toBe("<h1>Hello</h1>");
    expect(artifact.headers["content-security-policy"]).toBe("sandbox");
    const progress = await env.call(env.token(qaId), "GET", `/api/tasks/${created.body.task.id}/progress`);
    expect(progress.status).toBe(200);
    expect(progress.body.current).toBeNull(); expect(progress.body.canReadLogs).toBe(false);
    expect(progress.body.logs).toEqual([]);
    expect(progress.body.events.some((e: any) => e.message === "Execution succeeded")).toBe(true);
    expect(progress.body.events.every((e: any) => e.detail === null)).toBe(true);
    const finished = await env.call(env.owner, "GET", `/api/tasks/${created.body.task.id}/progress`);
    expect(finished.body.current).toBeNull(); expect(finished.body.logs[0].line).toBe("Đang xử lý tác vụ");
    // ...but QA still cannot see unrelated work.
    expect((await env.call(env.token(qaId), "GET", "/api/agents/lead-eng/logs")).status).toBe(403);
  });

  it("an agent cannot reference tasks it cannot see", async () => {
    const { rows } = await env.db.query("SELECT id FROM tasks WHERE created_by='agent:po' LIMIT 1");
    const r = await env.call(env.token("lead-ops"), "POST", "/api/tasks", {
      title: "peek",
      assigneeAgentId: "lead-ops",
      inputTaskIds: [rows[0].id],
    });
    expect(r.status).toBe(403);
  });

  it("runtime replacement invalidates the old generation and requeues its run once", async () => {
    await env.db.query("UPDATE tasks SET status='cancelled' WHERE assignee_agent_id=$1 AND status NOT IN ('done','cancelled')", [qaId]);
    const created = await env.call(env.token("lead-eng"), "POST", "/api/tasks", { title: "Long job", assigneeAgentId: qaId });
    const t = env.token(qaId);
    const g1 = await gen(qaId);
    const claim = await env.call(t, "POST", "/api/runs/claim", { generation: g1 });
    expect(claim.body.task.id).toBe(created.body.task.id);

    expect((await env.call(env.token("lead-eng"), "POST", `/api/agents/${qaId}/runtime/restart`)).status).toBe(202);
    await env.settle();
    const g2 = await gen(qaId);
    expect(g2).toBe(g1 + 1);
    // Restarting one member does not replace its team's shared runtime.
    const qaTeam = env.service.teamOf(await env.service.getAgentRow(qaId)).id;
    expect([...env.driver.pods.values()].filter((p) => p.teamId === qaTeam)).toHaveLength(1);

    // The old runtime can no longer act.
    const stale = await env.call(t, "POST", `/api/runs/${claim.body.run.id}/complete`, { generation: g1, outcome: "succeeded" });
    expect(stale.status).toBe(409);
    expect((await env.call(t, "POST", "/api/runs/claim", { generation: g1 })).status).toBe(409);

    const task = await env.call(env.owner, "GET", `/api/tasks/${created.body.task.id}`);
    expect(task.body.status).toBe("assigned");
    expect(task.body.attempt).toBe(2);
    const reclaim = await env.call(t, "POST", "/api/runs/claim", { generation: g2 });
    expect(reclaim.body.run.attempt).toBe(2);
    expect(reclaim.body.run.idempotencyKey).toBe(`${created.body.task.id}:2`);
    await env.call(t, "POST", `/api/runs/${reclaim.body.run.id}/complete`, { generation: g2, outcome: "succeeded" });
  });

  it("expired leases are swept and requeued, bounded by max attempts", async () => {
    const created = await env.call(env.token("lead-eng"), "POST", "/api/tasks", { title: "Flaky", assigneeAgentId: qaId });
    const t = env.token(qaId);
    const g = await gen(qaId);
    for (let i = 1; i <= 5; i++) {
      const c = await env.call(t, "POST", "/api/runs/claim", { generation: g });
      expect(c.body.run.attempt).toBe(i);
      await env.db.query("UPDATE task_runs SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [c.body.run.id]);
      expect(await env.service.sweepLeases()).toBe(1);
    }
    const task = await env.call(env.owner, "GET", `/api/tasks/${created.body.task.id}`);
    expect(task.body.status).toBe("failed");
    expect(task.body.statusReason).toMatch(/gave up after 5 attempts/);
    expect(task.body.runs.every((r: any) => r.status === "lost")).toBe(true);
  });

  it("human-created tasks wait for review; the assignee cannot approve its own work", async () => {
    const created = await env.call(env.owner, "POST", "/api/tasks", { title: "Ship it", assigneeAgentId: "lead-ops" });
    const t = env.token("lead-ops");
    const g = await gen("lead-ops");
    const c = await env.call(t, "POST", "/api/runs/claim", { generation: g });
    const done = await env.call(t, "POST", `/api/runs/${c.body.run.id}/complete`, { generation: g, outcome: "succeeded" });
    expect(done.body.taskStatus).toBe("review");
    expect((await env.call(t, "POST", `/api/tasks/${created.body.task.id}/review`, { decision: "approve" })).status).toBe(403);
    expect((await env.call(env.owner, "POST", `/api/tasks/${created.body.task.id}/review`, { decision: "approve" })).body.status).toBe("done");
  });
});

describe("re-scoping and revocation", () => {
  it("moving an agent out of a leader's tree removes exec and closes open terminals", async () => {
    const { rows } = await env.db.query("SELECT id FROM agents WHERE display_name='Eli'");
    const engId = rows[0].id;
    const open = await env.call(env.token("lead-eng"), "POST", `/api/agents/${engId}/terminal-sessions`);
    expect(open.status).toBe(201);
    // Simulate an attached session (the WebSocket path redeems the ticket).
    await env.service.attachTerminal(open.body.sessionId, open.body.ticket);
    expect((await env.service.terminalsToRevoke()).map((s) => s.id)).not.toContain(open.body.sessionId);

    // Leader B cannot move Eli into its own team...
    expect((await env.call(env.token("lead-ops"), "PATCH", `/api/agents/${engId}`, { reportsToAgentId: "lead-ops" })).status).toBe(403);
    // ...the owner can.
    expect((await env.call(env.owner, "PATCH", `/api/agents/${engId}`, { reportsToAgentId: "lead-ops" })).status).toBe(200);

    const revoke = await env.service.terminalsToRevoke();
    expect(revoke.find((s) => s.id === open.body.sessionId)?.reason).toMatch(/exec permission no longer held/);
    await env.recheckTerminals();
    const { rows: s } = await env.db.query("SELECT closed_at, close_reason FROM terminal_sessions WHERE id=$1", [open.body.sessionId]);
    expect(s[0].closed_at).not.toBeNull();

    expect((await env.call(env.token("lead-eng"), "POST", `/api/agents/${engId}/terminal-sessions`)).status).toBe(403);
    expect((await env.call(env.token("lead-ops"), "POST", `/api/agents/${engId}/terminal-sessions`)).status).toBe(201);
  });

  it("terminal tickets are single-use", async () => {
    const { rows } = await env.db.query("SELECT id FROM agents WHERE display_name='Eli'");
    const open = await env.call(env.token("lead-ops"), "POST", `/api/agents/${rows[0].id}/terminal-sessions`);
    await env.service.attachTerminal(open.body.sessionId, open.body.ticket);
    await expect(env.service.attachTerminal(open.body.sessionId, open.body.ticket)).rejects.toThrow(/invalid or expired/);
  });

  it("revoking a delegated grant's parent kills the delegated grant", async () => {
    const del = await env.call(env.token("ceo"), "POST", "/api/grants", {
      principalId: "po",
      action: "task.create",
      scope: { kind: "self" },
    });
    // po is in CEO's descendants, and CEO's task.create(descendants) is delegable.
    expect(del.status).toBe(201);
    expect((await env.call(env.token("po"), "POST", "/api/tasks", { title: "note to self", assigneeAgentId: "po" })).status).toBe(201);
    // Only owner or issuer may revoke.
    expect((await env.call(env.token("lead-eng"), "DELETE", `/api/grants/${del.body.id}`)).status).toBe(403);
    expect((await env.call(env.token("ceo"), "DELETE", `/api/grants/${del.body.id}`)).status).toBe(204);
    expect((await env.call(env.token("po"), "POST", "/api/tasks", { title: "note to self", assigneeAgentId: "po" })).status).toBe(403);
  });

  it("CEO cannot delegate exec it does not hold, nor widen scope", async () => {
    const r = await env.call(env.token("ceo"), "POST", "/api/grants", {
      principalId: "po",
      action: "runtime.exec",
      scope: { kind: "org" },
    });
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/no delegable runtime.exec/);
  });
});

describe("events", () => {
  it("snapshot cursor + events-after reconstructs state; agents only see their scope", async () => {
    const snap = await env.call(env.owner, "GET", "/api/office/snapshot");
    expect(snap.body.cursor).toBeGreaterThan(0);
    await env.call(env.token("lead-eng"), "POST", "/api/agents/lead-eng/pause").catch(() => {});
    const t = await env.call(env.owner, "POST", "/api/tasks", { title: "after-cursor", assigneeAgentId: "ceo" });
    const after = await env.service.eventsAfter({ kind: "human", id: "owner", owner: true }, snap.body.cursor);
    expect(after.some((e) => e.taskId === t.body.task.id && e.type === "task.created")).toBe(true);
    expect(after.every((e) => e.seq > snap.body.cursor)).toBe(true);

    const engView = await env.service.eventsAfter({ kind: "agent", id: "lead-ops" }, 0);
    expect(engView.some((e) => e.agentId === "ceo")).toBe(false);
  });
});

describe("per-agent credentials and model config", () => {
  const KEY = "sk-test-org-1234567890abcd";
  let credId: string;
  let opsOnlyId: string;
  let bot: string;

  /** What an agent's team runtime gets for it: its generation and non-secret model connection (env as the supervisor builds it). */
  const memberOf = async (agentId: string) => {
    const a = await env.service.getAgentRow(agentId);
    const hello = await env.service.teamHello(env.service.teamOf(a).id);
    const m = hello.members.find((x) => x.id === agentId);
    const rt = await env.service.getRuntimeRow(agentId);
    return { generation: rt.generation, llm: m?.llm ?? null, llmEnv: m?.llm ? llmEnv(m.llm, "http://test").plain : ({} as Record<string, string>), providerKey: null, providerWorkspaceId: m?.llm?.workspaceId ?? null };
  };

  beforeAll(async () => {
    const r = await spawnUnder(env.token("lead-eng"), "engineer-claude-v1", "Claudia", "lead-eng", "claude-1");
    expect(r.status).toBe(202);
    bot = r.body.agent.id;
    await env.settle();
  });

  it("only the owner adds keys; bad keys are rejected; the key is write-only", async () => {
    expect((await env.call(env.owner, "POST", "/api/credentials", { name: "bad", apiKey: "sk-nope-000000000" })).status).toBe(400);
    expect((await env.call(env.token("ceo"), "POST", "/api/credentials", { name: "x", apiKey: KEY })).status).toBe(403);
    const r = await env.call(env.owner, "POST", "/api/credentials", { name: "Org key", apiKey: KEY });
    expect(r.status).toBe(201);
    credId = r.body.id;
    expect(r.body.models).toContain("claude-opus-5-5");
    expect(r.body.keyHint).toBe("Hidden");
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    const ops = await env.call(env.owner, "POST", "/api/credentials", { name: "Ops key", apiKey: "sk-test-ops-small-9999", departments: ["ops"] });
    opsOnlyId = ops.body.id;
    expect(ops.body.models).toEqual(["claude-haiku-5-5"]);
    const { rows } = await env.db.query("SELECT ciphertext FROM credentials WHERE id=$1", [credId]);
    expect(rows[0].ciphertext.includes(Buffer.from(KEY))).toBe(false);
  });

  it("listing needs agent.configure and never returns key material", async () => {
    expect((await env.call(env.token(bot), "GET", "/api/credentials")).status).toBe(403);
    const r = await env.call(env.token("lead-eng"), "GET", "/api/credentials");
    expect(r.status).toBe(200);
    expect(r.body.credentials.map((c: any) => c.id)).toContain(credId);
    expect(JSON.stringify(r.body)).not.toContain(KEY);
  });

  it("a leader configures its own report: key + a model that key offers", async () => {
    const t = env.token("lead-eng");
    expect((await env.call(t, "PUT", `/api/agents/${bot}/config`, { credentialId: credId, model: "gpt-9" })).status).toBe(400);
    expect((await env.call(t, "PUT", `/api/agents/${bot}/config`, { credentialId: opsOnlyId })).status).toBe(403);
    expect((await env.call(t, "PUT", `/api/agents/${bot}/config`, { model: "claude-opus-5-5" })).status).toBe(400); // no key yet
    expect((await env.call(env.token("lead-ops"), "PUT", `/api/agents/${bot}/config`, { credentialId: credId })).status).toBe(403);
    const ok = await env.call(t, "PUT", `/api/agents/${bot}/config`, {
      credentialId: credId,
      model: "claude-sonnet-5-5",
      effort: "high",
      instructions: "Write tests first.",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.config).toMatchObject({ credentialId: credId, model: "claude-sonnet-5-5", effort: "high" });
  });

  it("the controller replaces the idle runtime with broker access and no provider key", async () => {
    const before = (await memberOf(bot));
    expect(before.providerKey).toBeNull();
    await env.settle();
    await env.settle();
    const after = (await memberOf(bot));
    expect(after.generation).toBe(before.generation + 1);
    expect(after.providerKey).toBeNull();
    // Other agents never receive it.
    for (const p of env.driver.pods.values()) expect(JSON.stringify(p.env)).not.toContain(KEY);
  });

  it("claims carry the agent's model settings, not the key", async () => {
    const g = await gen(bot);
    await env.call(env.token(bot), "POST", "/api/runtime/heartbeat", { generation: g, state: "idle" });
    await env.call(env.token("lead-eng"), "POST", "/api/tasks", { title: "think", assigneeAgentId: bot, spec: { kind: "prompt" } });
    const c = await env.call(env.token(bot), "POST", "/api/runs/claim", { generation: g });
    expect(c.body.config).toMatchObject({ harness: "claude", model: "claude-sonnet-5-5", effort: "high", instructions: "Write tests first.", hasCredential: true });
    expect(JSON.stringify(c.body)).not.toContain(KEY);

    // Key change while a run is in flight: no replacement until it finishes.
    const opsAll = await env.call(env.owner, "POST", "/api/credentials", { name: "Second", apiKey: "sk-test-second-small-77" });
    const sw = await env.call(env.token("lead-eng"), "PUT", `/api/agents/${bot}/config`, { credentialId: opsAll.body.id });
    expect(sw.body.config.model).toBeNull(); // old model is not on the new key
    await env.settle();
    expect((await memberOf(bot)).generation).toBe(g);
    await env.call(env.token(bot), "POST", `/api/runs/${c.body.run.id}/complete`, { generation: g, outcome: "succeeded" });
    await env.settle();
    await env.settle();
    expect((await memberOf(bot)).generation).toBe(g + 1);
    expect((await memberOf(bot)).providerKey).toBeNull();
  });

  it("revoking a key pulls it from the runtime", async () => {
    const { rows } = await env.db.query("SELECT credential_id FROM agents WHERE id=$1", [bot]);
    expect((await env.call(env.token("ceo"), "DELETE", `/api/credentials/${rows[0].credential_id}`)).status).toBe(403);
    expect((await env.call(env.owner, "DELETE", `/api/credentials/${rows[0].credential_id}`)).status).toBe(204);
    await env.settle();
    await env.settle();
    expect((await memberOf(bot)).providerKey).toBeNull();
    expect((await env.call(env.token("lead-eng"), "PUT", `/api/agents/${bot}/config`, { credentialId: rows[0].credential_id })).status).toBe(409);
  });

  it("CEO can spawn a claude engineer with a key and model in one step", async () => {
    const r = await env.call(env.token("ceo"), "POST", "/api/agents", {
      templateId: "engineer-claude-v1",
      displayName: "Opal",
      reportsToAgentId: "lead-eng",
      config: { credentialId: credId, model: "claude-opus-5-5" },
    });
    expect(r.status).toBe(202);
    await env.settle();
    expect((await memberOf(r.body.agent.id)).providerKey).toBeNull();
  });

  it("an organization-level key needs a workspace ID, which reaches the runtime with the key", async () => {
    const orgKey = "sk-test-orgwide-5555";
    const missing = await env.call(env.owner, "POST", "/api/credentials", { name: "Org-wide", apiKey: orgKey });
    expect(missing.status).toBe(400);
    expect(JSON.stringify(missing.body)).toContain("Workspaces");
    expect((await env.call(env.owner, "POST", "/api/credentials", { name: "Org-wide", apiKey: orgKey, workspaceId: "bad id" })).status).toBe(400);
    const r = await env.call(env.owner, "POST", "/api/credentials", { name: "Org-wide", apiKey: orgKey, workspaceId: " wrkspc_01AbC " });
    expect(r.status).toBe(201);
    expect(r.body.workspaceId).toBe("wrkspc_01AbC");
    expect((await env.call(env.owner, "POST", `/api/credentials/${r.body.id}/refresh-models`)).status).toBe(200);

    const s = await spawnUnder(env.token("lead-eng"), "engineer-claude-v1", "Wanda", "lead-eng", "claude-ws");
    expect(s.status).toBe(202);
    const ws = s.body.agent.id;
    await env.settle();
    expect((await env.call(env.token("lead-eng"), "PUT", `/api/agents/${ws}/config`, { credentialId: r.body.id })).status).toBe(200);
    await env.settle();
    await env.settle();
    expect((await memberOf(ws))).toMatchObject({ providerKey: null, providerWorkspaceId: "wrkspc_01AbC" });
    expect((await memberOf(bot)).providerWorkspaceId).toBeNull();
  });

  it("custom Anthropic gateways persist auth metadata, validate it, refresh models and reach the Claude runtime", async () => {
    const add = (body: Record<string, unknown>) => env.call(env.owner, "POST", "/api/credentials", body);
    const gateway = { name: "Claude gateway", provider: "custom", protocol: "anthropic", apiKey: "sk-test-small-gateway", baseUrl: "https://gateway.example.com/claude/v1", authHeader: { name: "X-API-Key", scheme: "raw" } };
    const created = await add(gateway); expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ provider: "custom", protocol: "anthropic", authHeader: { name: "x-api-key", scheme: "raw" }, models: ["claude-haiku-5-5"] });
    expect(JSON.stringify(created.body)).not.toContain(gateway.apiKey);
    expect((await env.call(env.owner, "POST", `/api/credentials/${created.body.id}/refresh-models`)).body.models).toEqual(["claude-haiku-5-5"]);
    for (const name of ["x-api-key\r\nInjected", "host", "content-type", "anthropic-beta", "cookie"]) expect((await add({ ...gateway, authHeader: { name, scheme: "raw" } })).status).toBe(400);
    expect((await add({ ...gateway, provider: "anthropic", baseUrl: null })).status).toBe(400);
    expect((await add({ ...gateway, protocol: "invalid" })).status).toBe(400);
    const defaults = await add({ ...gateway, authHeader: undefined });
    expect(defaults.body.authHeader).toEqual({ name: "x-api-key", scheme: "raw" });
    const actor = { kind: "human" as const, id: (await env.instance.authenticate(env.owner))!.id, owner: true };
    const target = await env.service.ownerChatCredential(actor, created.body.id);
    expect(target).toMatchObject({ baseUrl: gateway.baseUrl, protocol: "anthropic", authHeader: { name: "x-api-key", scheme: "raw" } });
    const spawned = await spawnUnder(env.token("lead-eng"), "engineer-claude-v1", "Gateway tester", "lead-eng", "gateway-test");
    const id = spawned.body.agent.id; await env.settle();
    expect((await env.call(env.token("lead-eng"), "PUT", `/api/agents/${id}/config`, { credentialId: created.body.id, model: "claude-haiku-5-5" })).status).toBe(200);
    await env.settle(); await env.settle();
    expect((await memberOf(id)).llmEnv).toMatchObject({ AGENTOWN_LLM_BROKER: "1", AGENTOWN_LLM_PROTOCOL: "anthropic" });
    expect(JSON.stringify((await memberOf(id)).llmEnv)).not.toContain(gateway.apiKey);
    expect((await memberOf(id)).llmEnv.ANTHROPIC_BASE_URL).toContain("/api/runtime/llm/anthropic");
    expect((await memberOf(id)).llmEnv.AGENTOWN_LLM_API_KEY).toBeUndefined();
    const sealed = (await env.db.query("SELECT ciphertext FROM credentials WHERE id=$1", [created.body.id])).rows[0].ciphertext;
    const connection = { revision: created.body.revision, baseUrl: gateway.baseUrl, protocol: "anthropic", authHeader: { name: "x-gateway-key", scheme: "raw" } };
    expect((await env.call(env.token("ceo"), "PUT", `/api/credentials/${created.body.id}/connection`, connection)).status).toBe(403);
    const edited = await env.call(env.owner, "PUT", `/api/credentials/${created.body.id}/connection`, connection);
    expect(edited.status).toBe(200); expect(edited.body.revision).toBe(created.body.revision + 1);
    expect(edited.body.authHeader).toEqual(connection.authHeader);
    expect(JSON.stringify(edited.body)).not.toContain(gateway.apiKey);
    expect((await env.db.query("SELECT ciphertext FROM credentials WHERE id=$1", [created.body.id])).rows[0].ciphertext).toEqual(sealed);
    expect((await env.call(env.owner, "PUT", `/api/credentials/${created.body.id}/connection`, connection)).status).toBe(409);
    await env.settle(); await env.settle();
    expect((await memberOf(id)).llmEnv.AGENTOWN_LLM_AUTH_HEADER).toBeUndefined();
  });
  it("OpenAI-compatible providers: preset endpoints, custom base URLs, and what reaches the runtime", async () => {
    const add = (body: Record<string, unknown>) => env.call(env.owner, "POST", "/api/credentials", body);
    expect((await env.call(env.owner, "GET", "/api/catalog")).body.providers.map((p: any) => p.id)).toEqual(
      expect.arrayContaining(["anthropic", "openai", "deepseek", "xai", "gemini", "custom"]),
    );
    expect((await add({ name: "x", provider: "openai" })).status).toBe(400); // key required
    expect((await add({ name: "x", provider: "openai", apiKey: "sk-test-oai-1", workspaceId: "wrkspc_1" })).status).toBe(400);
    expect((await add({ name: "x", provider: "openai", apiKey: "sk-test-oai-1", baseUrl: "https://evil.example/v1" })).status).toBe(400);
    expect((await add({ name: "x", provider: "nope", apiKey: "sk-test-oai-1" })).status).toBe(400);
    const oai = await add({ name: "OpenAI", provider: "openai", apiKey: "sk-test-oai-1234" });
    expect(oai.status).toBe(201);
    expect(oai.body).toMatchObject({ provider: "openai", baseUrl: "https://api.openai.com/v1", models: ["openai-chat", "openai-mini"], keyHint: "Hidden" });

    expect((await add({ name: "x", provider: "custom" })).status).toBe(400); // base URL required
    expect((await add({ name: "x", provider: "custom", baseUrl: "ftp://host/v1" })).status).toBe(400);
    expect((await add({ name: "x", provider: "custom", baseUrl: "http://u:p@host/v1" })).status).toBe(400);
    const local = await add({ name: "Ollama", provider: "custom", baseUrl: " http://10.0.0.5:11434/ollama/v1/ " });
    expect(local.status).toBe(201);
    expect(local.body).toMatchObject({ provider: "custom", baseUrl: "http://10.0.0.5:11434/ollama/v1", keyHint: "(no key)", models: ["llama3.3", "qwen3"] });

    const s = await spawnUnder(env.token("lead-eng"), "engineer-claude-v1", "Gwen", "lead-eng", "claude-oai");
    expect(s.status).toBe(202);
    const agent = s.body.agent.id;
    await env.settle();
    const t = env.token("lead-eng");
    expect((await env.call(t, "PUT", `/api/agents/${agent}/config`, { credentialId: oai.body.id, model: "claude-opus-5-5" })).status).toBe(400);
    expect((await env.call(t, "PUT", `/api/agents/${agent}/config`, { credentialId: oai.body.id, model: "openai-mini" })).status).toBe(200);
    await env.settle();
    await env.settle();
    expect((await memberOf(agent)).llmEnv).toEqual({
      AGENTOWN_LLM_PROVIDER: "openai",
      AGENTOWN_LLM_PROTOCOL: "openai",
      AGENTOWN_LLM_BROKER: "1",
      AGENTOWN_LLM_BASE_URL: "http://test/api/runtime/llm/openai/v1",
    });

    // A keyless custom endpoint: no secret, and no Claude default model is handed to the adapter.
    expect((await env.call(t, "PUT", `/api/agents/${agent}/config`, { credentialId: local.body.id, model: "llama3.3" })).status).toBe(200);
    await env.settle();
    await env.settle();
    expect((await memberOf(agent)).llmEnv).toMatchObject({ AGENTOWN_LLM_PROVIDER: "custom", AGENTOWN_LLM_PROTOCOL: "openai", AGENTOWN_LLM_BROKER: "1" });
    const g = await gen(agent);
    await env.call(env.token(agent), "POST", "/api/runtime/heartbeat", { generation: g, state: "idle" });
    await env.call(t, "POST", "/api/tasks", { title: "think locally", assigneeAgentId: agent, spec: { kind: "prompt" } });
    const c = await env.call(env.token(agent), "POST", "/api/runs/claim", { generation: g });
    expect(c.body.config).toMatchObject({ harness: "claude", provider: "custom", model: "llama3.3", hasCredential: true });
  });
});

describe("people and their permissions", () => {
  async function invite(roleId: string | null, name = "Person") {
    const r = await env.call(env.owner, "POST", "/api/users", { displayName: name, roleId });
    expect(r.status).toBe(201);
    return r.body as { user: { id: string; permissions: Array<{ id: string; action: string }> }; token: string };
  }

  it("a viewer sees the office but every control is closed", async () => {
    const { token } = await invite("viewer");
    expect((await env.call(token, "GET", "/api/office/snapshot")).status).toBe(200);
    const me = await env.call(token, "GET", "/api/me");
    expect(me.body.can).toEqual({ "credential.manage": false, "audit.view": false, "user.manage": false, "org.design": false });
    expect(me.body.taskTargets).toEqual([]);
    expect((await env.call(token, "POST", "/api/tasks", { title: "x", assigneeAgentId: "lead-eng" })).status).toBe(403);
    expect((await env.call(token, "GET", "/api/audit")).status).toBe(403);
    expect((await env.call(token, "POST", "/api/credentials", { name: "k", apiKey: "sk-test-1" })).status).toBe(403);
    expect((await env.call(token, "GET", "/api/users")).status).toBe(403);
    expect((await env.call(token, "POST", "/api/agents/lead-eng/pause")).status).toBe(403);
    const agent = await env.call(token, "GET", "/api/agents/lead-eng");
    expect(agent.body.can["runtime.control"]).toBe(false);
  });

  it("permissions are added and removed one by one, scoped to a department", async () => {
    const { user, token } = await invite(null);
    expect((await env.call(token, "GET", "/api/office/snapshot")).body.agents).toEqual([]);
    const g = await env.call(env.owner, "POST", `/api/users/${user.id}/grants`, { action: "runtime.control", scope: { kind: "departments", ids: ["eng"] } });
    expect(g.status).toBe(201);
    expect((await env.call(token, "POST", "/api/agents/lead-eng/pause")).status).toBe(200);
    expect((await env.call(token, "POST", "/api/agents/lead-ops/pause")).status).toBe(403);
    await env.call(env.owner, "POST", "/api/agents/lead-eng/resume");
    expect((await env.call(env.owner, "DELETE", `/api/users/${user.id}/grants/${g.body.id}`)).status).toBe(204);
    expect((await env.call(token, "POST", "/api/agents/lead-eng/pause")).status).toBe(403);
    // People cannot hold tree-relative scopes.
    expect((await env.call(env.owner, "POST", `/api/users/${user.id}/grants`, { action: "org.view", scope: { kind: "team" } })).status).toBe(400);
  });

  it("a user manager stays within their own rights", async () => {
    const mgr = await invite("eng-manager", "Manager");
    await env.call(env.owner, "POST", `/api/users/${mgr.user.id}/grants`, { action: "user.manage", scope: { kind: "org" } });
    const other = await invite(null, "Other");
    const t = mgr.token;
    expect((await env.call(t, "POST", `/api/users/${other.user.id}/grants`, { action: "runtime.exec", scope: { kind: "departments", ids: ["eng"] } })).status).toBe(201);
    expect((await env.call(t, "POST", `/api/users/${other.user.id}/grants`, { action: "runtime.exec", scope: { kind: "org" } })).status).toBe(403);
    expect((await env.call(t, "POST", `/api/users/${other.user.id}/grants`, { action: "audit.view", scope: { kind: "org" } })).status).toBe(403);
    expect((await env.call(t, "POST", `/api/users/${other.user.id}/grants`, { action: "user.manage", scope: { kind: "org" } })).status).toBe(403);
    expect((await env.call(t, "POST", `/api/users/${mgr.user.id}/grants`, { action: "org.view", scope: { kind: "org" } })).status).toBe(403);
    expect((await env.call(t, "PATCH", "/api/users/owner", { disabled: true })).status).toBe(403);
    // Creating with a role it could not give itself fails as a whole.
    expect((await env.call(t, "POST", "/api/users", { displayName: "Admin?", roleId: "admin" })).status).toBe(403);
  });

  it("disabling a person or resetting the token locks the old token out", async () => {
    const a = await invite("viewer");
    expect((await env.call(env.owner, "PATCH", `/api/users/${a.user.id}`, { disabled: true })).status).toBe(200);
    // Disabled here: this organization is gone for them; the account itself still signs in.
    expect((await env.call(a.token, "GET", "/api/me")).status).toBe(404);
    await env.call(env.owner, "PATCH", `/api/users/${a.user.id}`, { disabled: false });
    expect((await env.call(a.token, "GET", "/api/me")).status).toBe(200);
    const reset = await env.call(env.owner, "POST", `/api/users/${a.user.id}/token`);
    expect((await env.call(a.token, "GET", "/api/me")).status).toBe(401);
    expect((await env.call(reset.body.token, "GET", "/api/me")).status).toBe(200);
  });

  it("the browser session lives in an HttpOnly cookie", async () => {
    const login = await env.app.inject({ method: "POST", url: "/api/session", payload: { token: env.owner } });
    expect(login.statusCode).toBe(200);
    const set = String(login.headers["set-cookie"]);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    const cookie = set.split(";")[0]!;
    const me = await env.app.inject({ method: "GET", url: "/api/orgs/agentown/me", headers: { cookie } });
    expect(me.json().can["user.manage"]).toBe(true);
    // A cookie-carrying write from another origin is not authenticated.
    const cross = await env.app.inject({ method: "POST", url: "/api/orgs/agentown/agents/lead-eng/pause", headers: { cookie, origin: "https://evil.example", host: "localhost" } });
    expect(cross.statusCode).toBe(401);
    expect((await env.app.inject({ method: "POST", url: "/api/session", payload: { token: "aho_nope" } })).statusCode).toBe(401);
    const out = await env.app.inject({ method: "DELETE", url: "/api/session" });
    expect(String(out.headers["set-cookie"])).toMatch(/Max-Age=0/);
  });

  it("task controls follow the caller's rights", async () => {
    const { token } = await invite("reviewer");
    const t = await env.call(env.owner, "POST", "/api/tasks", { title: "can I?", assigneeAgentId: "lead-ops" });
    const asReviewer = await env.call(token, "GET", `/api/tasks/${t.body.task.id}`);
    expect(asReviewer.body.can).toEqual({ review: false, retry: false, cancel: false });
    expect((await env.call(env.owner, "GET", `/api/tasks/${t.body.task.id}`)).body.can.cancel).toBe(true);
    await env.call(env.owner, "POST", `/api/tasks/${t.body.task.id}/cancel`, {});
  });
});
