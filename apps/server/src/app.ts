import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { ACTIONS, type Actor, EFFORTS, WORK_STATES } from "@agentown/core";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { RuntimeDriver } from "./runtime/driver.ts";
import type { Service } from "./service.ts";
import { ApiError, badRequest } from "./util.ts";

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

const scopeSchema = z.union([
  z.object({ kind: z.enum(["self", "direct-reports", "descendants", "team", "department", "org"]) }),
  z.object({ kind: z.literal("agents"), ids: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("projects"), ids: z.array(z.string()).min(1) }),
]);

const agentConfigSchema = z
  .object({
    credentialId: z.string().nullable(),
    model: z.string().max(100).nullable(),
    effort: z.enum(EFFORTS).nullable(),
    instructions: z.string().max(8000),
    maxTurns: z.number().int().min(1).max(200),
  })
  .partial()
  .strict();

const S = {
  agentConfig: agentConfigSchema,
  credential: z.object({
    name: z.string().min(1).max(60),
    provider: z.enum(["anthropic"]).default("anthropic"),
    apiKey: z.string().min(8).max(500),
    departments: z.array(z.string()).nullable().default(null),
  }),
  spawn: z.object({
    templateId: z.string(),
    displayName: z.string().min(1).max(40),
    reportsToAgentId: z.string().nullable(),
    departmentId: z.string().optional(),
    idempotencyKey: z.string().max(100).optional(),
    config: agentConfigSchema.optional(),
  }),
  updateAgent: z.object({ displayName: z.string().min(1).max(40).optional(), reportsToAgentId: z.string().nullable().optional() }),
  retire: z.object({ purgeWorkspace: z.boolean().default(false) }).default({}),
  createTask: z.object({
    title: z.string().min(1).max(200),
    description: z.string().max(20000).optional(),
    acceptanceCriteria: z.string().max(5000).optional(),
    assigneeAgentId: z.string().nullable().optional(),
    projectId: z.string().nullable().optional(),
    parentTaskId: z.string().nullable().optional(),
    spec: z.unknown().optional(),
    inputTaskIds: z.array(z.string()).max(20).optional(),
    requiresReview: z.boolean().optional(),
    idempotencyKey: z.string().max(100).optional(),
  }),
  assign: z.object({ assigneeAgentId: z.string() }),
  cancel: z.object({ reason: z.string().max(500).default("") }).default({}),
  review: z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(2000).default("") }),
  delegate: z.object({
    principalId: z.string(),
    action: z.enum(ACTIONS),
    scope: scopeSchema,
    constraints: z.object({ templates: z.array(z.string()).optional() }).default({}),
    delegable: z.boolean().default(false),
    expiresAt: z.string().datetime().nullable().optional(),
  }),
  heartbeat: z.object({ generation: z.number().int(), state: z.enum(WORK_STATES), detail: z.string().max(1000).optional() }),
  claim: z.object({ generation: z.number().int() }),
  gen: z.object({ generation: z.number().int() }),
  runLogs: z.object({ generation: z.number().int(), lines: z.array(z.object({ stream: z.string(), line: z.string() })).max(500) }),
  runEvent: z.object({ generation: z.number().int(), type: z.string(), message: z.string().optional(), data: z.record(z.unknown()).optional() }),
  artifact: z.object({ generation: z.number().int(), name: z.string(), contentType: z.string().default("application/octet-stream"), contentBase64: z.string() }),
  complete: z.object({
    generation: z.number().int(),
    outcome: z.enum(["succeeded", "failed", "blocked"]),
    summary: z.string().max(8000).optional(),
    usage: z.record(z.unknown()).optional(),
  }),
};

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw badRequest("invalid request body", r.error.flatten());
  return r.data;
}

function actorOf(req: FastifyRequest): Actor {
  if (!req.actor) throw new ApiError(401, "unauthenticated", "missing or invalid bearer token");
  return req.actor;
}

export interface AppOptions {
  service: Service;
  driver: RuntimeDriver | null;
  webDist?: string;
  logger?: boolean;
  onStateChange?: () => void;
}

export async function buildApp(opts: AppOptions) {
  const { service, driver } = opts;
  const app = Fastify({ logger: opts.logger ? { level: "info" } : false, bodyLimit: 4 * 1024 * 1024 });
  await app.register(fastifyWebsocket);

  app.decorateRequest("actor", null);
  app.addHook("onRequest", async (req) => {
    const h = req.headers.authorization;
    if (h?.startsWith("Bearer ")) req.actor = await service.authenticate(h.slice(7).trim());
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, detail: err.detail });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: "bad_request", message: err.message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: "internal", message: "internal error" });
  });

  const changed = <T>(v: T): T => {
    opts.onStateChange?.();
    return v;
  };

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/api/me", async (req) => ({ actor: actorOf(req) }));
  app.get("/api/catalog", async (req) => service.catalog(actorOf(req)));
  app.get("/api/office/snapshot", async (req) => service.snapshot(actorOf(req)));

  // ---- agents
  app.get("/api/agents", async (req) => ({ agents: await service.listAgents(actorOf(req)) }));
  app.post("/api/agents", async (req, reply) => {
    const out = await service.spawn(actorOf(req), parse(S.spawn, req.body));
    reply.status(out.existing ? 200 : 202);
    return changed(out);
  });
  app.get<{ Params: { id: string } }>("/api/agents/:id", async (req) => service.getAgent(actorOf(req), req.params.id));
  app.patch<{ Params: { id: string } }>("/api/agents/:id", async (req) =>
    changed(await service.updateAgent(actorOf(req), req.params.id, parse(S.updateAgent, req.body))),
  );
  app.post<{ Params: { id: string } }>("/api/agents/:id/pause", async (req) => changed(await service.setIntake(actorOf(req), req.params.id, false)));
  app.post<{ Params: { id: string } }>("/api/agents/:id/resume", async (req) => changed(await service.setIntake(actorOf(req), req.params.id, true)));
  for (const op of ["start", "stop", "restart"] as const) {
    app.post<{ Params: { id: string } }>(`/api/agents/:id/runtime/${op}`, async (req, reply) => {
      reply.status(202);
      return changed(await service.setRuntime(actorOf(req), req.params.id, op));
    });
  }
  app.post<{ Params: { id: string } }>("/api/agents/:id/retire", async (req) =>
    changed(await service.retire(actorOf(req), req.params.id, parse(S.retire, req.body).purgeWorkspace)),
  );
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/agents/:id/logs", async (req) => ({
    lines: await service.logs(actorOf(req), req.params.id, Number(req.query.after ?? 0)),
  }));

  app.put<{ Params: { id: string } }>("/api/agents/:id/config", async (req) =>
    changed(await service.configureAgent(actorOf(req), req.params.id, parse(S.agentConfig, req.body))),
  );

  // ---- credentials (owner-managed; the key is write-only)
  app.get("/api/credentials", async (req) => ({ credentials: await service.listCredentials(actorOf(req)) }));
  app.post("/api/credentials", async (req, reply) => {
    reply.status(201);
    return service.createCredential(actorOf(req), parse(S.credential, req.body));
  });
  app.post<{ Params: { id: string } }>("/api/credentials/:id/refresh-models", async (req) =>
    service.refreshCredentialModels(actorOf(req), req.params.id),
  );
  app.delete<{ Params: { id: string } }>("/api/credentials/:id", async (req, reply) => {
    await service.revokeCredential(actorOf(req), req.params.id);
    changed(null);
    return reply.status(204).send();
  });

  // ---- grants
  app.post("/api/grants", async (req, reply) => {
    reply.status(201);
    return changed(await service.delegate(actorOf(req), parse(S.delegate, req.body)));
  });
  app.delete<{ Params: { id: string } }>("/api/grants/:id", async (req, reply) => {
    await service.revokeGrant(actorOf(req), req.params.id);
    changed(null);
    return reply.status(204).send();
  });

  // ---- tasks
  app.get<{ Querystring: { assignee?: string; status?: string } }>("/api/tasks", async (req) => ({
    tasks: await service.listTasks(actorOf(req), req.query),
  }));
  app.post("/api/tasks", async (req, reply) => {
    const out = await service.createTask(actorOf(req), parse(S.createTask, req.body));
    reply.status(out.existing ? 200 : 201);
    return out;
  });
  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (req) => service.getTask(actorOf(req), req.params.id));
  app.post<{ Params: { id: string } }>("/api/tasks/:id/assign", async (req) =>
    service.assignTask(actorOf(req), req.params.id, parse(S.assign, req.body).assigneeAgentId),
  );
  app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (req) =>
    service.cancelTask(actorOf(req), req.params.id, parse(S.cancel, req.body).reason),
  );
  app.post<{ Params: { id: string } }>("/api/tasks/:id/retry", async (req) => service.retryTask(actorOf(req), req.params.id));
  app.post<{ Params: { id: string } }>("/api/tasks/:id/review", async (req) => {
    const b = parse(S.review, req.body);
    return service.reviewTask(actorOf(req), req.params.id, b.decision, b.note);
  });
  app.get<{ Params: { id: string } }>("/api/artifacts/:id", async (req, reply) => {
    const a = await service.getArtifact(actorOf(req), req.params.id);
    reply.header("content-type", a.contentType).header("x-content-sha256", a.sha256);
    // Artifacts are agent-produced: never let the browser render them as our origin.
    reply.header("content-security-policy", "sandbox").header("x-content-type-options", "nosniff");
    reply.header("content-disposition", `inline; filename="${a.name}"`);
    return reply.send(a.content);
  });

  // ---- harness-facing (agent token + runtime generation)
  app.post("/api/runtime/heartbeat", async (req) => service.heartbeat(actorOf(req), parse(S.heartbeat, req.body)));
  app.post("/api/runs/claim", async (req, reply) => {
    const out = await service.claim(actorOf(req), parse(S.claim, req.body).generation);
    if (!out) return reply.status(204).send();
    return out;
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/heartbeat", async (req) =>
    service.runHeartbeat(actorOf(req), req.params.id, parse(S.gen, req.body).generation),
  );
  app.post<{ Params: { id: string } }>("/api/runs/:id/logs", async (req, reply) => {
    const b = parse(S.runLogs, req.body);
    await service.runLogs(actorOf(req), req.params.id, b.generation, b.lines);
    return reply.status(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/events", async (req, reply) => {
    const b = parse(S.runEvent, req.body);
    await service.runEvent(actorOf(req), req.params.id, b.generation, b);
    return reply.status(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/artifacts", async (req, reply) => {
    const b = parse(S.artifact, req.body);
    reply.status(201);
    return service.uploadArtifact(actorOf(req), req.params.id, b.generation, {
      name: b.name,
      contentType: b.contentType,
      content: Buffer.from(b.contentBase64, "base64"),
    });
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/complete", async (req) => {
    const b = parse(S.complete, req.body);
    return service.completeRun(actorOf(req), req.params.id, b.generation, b);
  });

  // ---- audit
  app.get<{ Querystring: { after?: string } }>("/api/audit", async (req) => ({
    events: await service.listAudit(actorOf(req), Number(req.query.after ?? 0)),
  }));

  // ---- events (SSE). Client: GET snapshot -> cursor -> GET /api/events?after=cursor.
  app.get<{ Querystring: { after?: string } }>("/api/events", async (req, reply) => {
    const actor = actorOf(req);
    let cursor = Number(req.query.after ?? req.headers["last-event-id"] ?? 0);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let visible = await service.visibleFilter(actor);
    const queue: Array<Parameters<typeof visible>[0]> = [];
    let replaying = true;
    const write = (e: Parameters<typeof visible>[0]) => {
      if (e.seq <= cursor || !visible(e)) return;
      cursor = e.seq;
      res.write(`id: ${e.seq}\nevent: agent-event\ndata: ${JSON.stringify(e)}\n\n`);
    };
    const unsubscribe = service.bus.subscribe((e) => (replaying ? queue.push(e) : write(e)));
    for (const e of await service.eventsAfter(actor, cursor, 5000)) write(e);
    replaying = false;
    for (const e of queue.splice(0)) write(e);
    const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15000);
    const refresh = setInterval(async () => {
      visible = await service.visibleFilter(actor).catch(() => visible);
    }, 10000);
    req.raw.on("close", () => {
      unsubscribe();
      clearInterval(ping);
      clearInterval(refresh);
    });
  });

  // ---- terminal: POST mints a one-time ticket (header auth); the WebSocket redeems it.
  const terminals = new Map<string, (reason: string) => void>();
  app.post<{ Params: { id: string } }>("/api/agents/:id/terminal-sessions", async (req, reply) => {
    if (!driver) throw new ApiError(501, "no_runtime", "no runtime driver configured");
    reply.status(201);
    return service.openTerminal(actorOf(req), req.params.id);
  });
  app.get<{ Params: { sid: string }; Querystring: { ticket?: string } }>(
    "/api/terminal-sessions/:sid/attach",
    { websocket: true },
    async (socket, req) => {
      const sid = req.params.sid;
      let target: Awaited<ReturnType<Service["attachTerminal"]>>;
      try {
        target = await service.attachTerminal(sid, req.query.ticket ?? "");
      } catch (err) {
        socket.send(JSON.stringify({ type: "exit", reason: (err as Error).message }));
        socket.close(4403, "denied");
        return;
      }
      const stdin = new PassThrough();
      const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
      let closed = false;
      let exec: { close: () => void } | null = null;
      const close = (reason: string) => {
        if (closed) return;
        closed = true;
        terminals.delete(sid);
        try {
          socket.send(JSON.stringify({ type: "exit", reason }));
        } catch {}
        socket.close();
        exec?.close();
        void service.closeTerminal(sid, reason);
      };
      terminals.set(sid, close);
      stdout.on("data", (d: Buffer) => socket.send(JSON.stringify({ type: "output", data: d.toString("utf8") })));
      socket.on("message", (raw: Buffer) => {
        try {
          const m = JSON.parse(raw.toString());
          if (m.type === "input" && typeof m.data === "string") stdin.write(m.data);
          if (m.type === "resize" && Number.isInteger(m.cols) && Number.isInteger(m.rows)) {
            stdout.columns = Math.min(Math.max(m.cols, 10), 400);
            stdout.rows = Math.min(Math.max(m.rows, 5), 200);
            stdout.emit("resize");
          }
        } catch {}
      });
      socket.on("close", () => close("client disconnected"));
      try {
        exec = await driver!.exec(target.namespace, target.pod, ["/bin/sh", "-l"], {
          stdin,
          stdout,
          onExit: (s) => close(`shell exited${s.message ? `: ${s.message}` : ""}`),
        });
        if (closed) exec.close();
      } catch (err) {
        close(`exec failed: ${(err as Error).message}`);
      }
    },
  );

  /** Close every live terminal whose actor lost runtime.exec or whose runtime generation changed. */
  async function recheckTerminals() {
    for (const { id, reason } of await service.terminalsToRevoke()) {
      const close = terminals.get(id);
      if (close) close(reason);
      else await service.closeTerminal(id, reason);
    }
  }

  if (opts.webDist && existsSync(opts.webDist)) {
    await app.register(fastifyStatic, { root: opts.webDist });
    app.setNotFoundHandler((req, reply: FastifyReply) => {
      if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "not_found", message: "no such route" });
      return reply.sendFile("index.html");
    });
  }

  return { app, recheckTerminals, terminals };
}
