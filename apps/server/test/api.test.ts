import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";

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
      url: `/api/artifacts/${seen.body.artifacts[0].id}`,
      headers: { authorization: `Bearer ${env.token(qaId)}` },
    });
    expect(artifact.body).toBe("<h1>Hello</h1>");
    expect(artifact.headers["content-security-policy"]).toBe("sandbox");
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
    expect([...env.driver.pods.keys()].filter((p) => p.startsWith(`agent-${qaId}-`))).toEqual([`agent-${qaId}-g${g2}`]);

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
    for (let i = 1; i <= 3; i++) {
      const c = await env.call(t, "POST", "/api/runs/claim", { generation: g });
      expect(c.body.run.attempt).toBe(i);
      await env.db.query("UPDATE task_runs SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [c.body.run.id]);
      expect(await env.service.sweepLeases()).toBe(1);
    }
    const task = await env.call(env.owner, "GET", `/api/tasks/${created.body.task.id}`);
    expect(task.body.status).toBe("failed");
    expect(task.body.statusReason).toMatch(/gave up after 3 attempts/);
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
    const after = await env.service.eventsAfter({ kind: "human", id: "owner", role: "owner" }, snap.body.cursor);
    expect(after.some((e) => e.taskId === t.body.task.id && e.type === "task.created")).toBe(true);
    expect(after.every((e) => e.seq > snap.body.cursor)).toBe(true);

    const engView = await env.service.eventsAfter({ kind: "agent", id: "lead-ops" }, 0);
    expect(engView.some((e) => e.agentId === "ceo")).toBe(false);
  });
});
