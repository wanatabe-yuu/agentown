import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { ACTIONS, type Actor, EFFORTS, WORK_STATES } from "@agentown/core";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { PROVIDERS } from "./providers.ts";
import type { RuntimeDriver } from "./runtime/driver.ts";
import type { Instance, Principal } from "./instance.ts";
import type { Service } from "./service.ts";
import { ApiError, badRequest } from "./util.ts";

declare module "fastify" {
  interface FastifyRequest {
    /** Who the token belongs to. */
    principal: Principal | null;
    /** That principal as the organization in the URL (or the agent's own org) sees it. */
    actor: Actor | null;
    svc: Service | null;
  }
}

const scopeSchema = z.union([
  z.object({ kind: z.enum(["self", "direct-reports", "descendants", "team", "department", "org"]) }),
  z.object({ kind: z.literal("agents"), ids: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("projects"), ids: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("departments"), ids: z.array(z.string()).min(1) }),
]);

/** The browser keeps the token in an HttpOnly cookie, so page scripts never see it. */
const SESSION_COOKIE = "agentown_token";
const SESSION_MAX_AGE = 30 * 24 * 3600;

function readCookie(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function sessionCookie(req: FastifyRequest, value: string, maxAge: number): string {
  const secure = req.protocol === "https" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

/** Cookie-authenticated writes must come from our own origin (SameSite=Strict plus a belt-and-braces check). */
function sameOrigin(req: FastifyRequest): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

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
    provider: z.enum(PROVIDERS).default("anthropic"),
    apiKey: z.string().max(500).nullable().optional(),
    workspaceId: z.string().trim().max(120).nullable().optional(),
    baseUrl: z.string().trim().max(500).nullable().optional(),
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
  retire: z.object({ purgeWorkspace: z.boolean().default(false) }).prefault({}),
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
  cancel: z.object({ reason: z.string().max(500).default("") }).prefault({}),
  review: z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(2000).default("") }),
  session: z.object({ token: z.string().min(1).max(200) }),
  createUser: z.object({ displayName: z.string().trim().min(1).max(60), roleId: z.string().nullable().optional() }),
  updateUser: z.object({ displayName: z.string().trim().min(1).max(60).optional(), disabled: z.boolean().optional(), roleId: z.string().optional() }),
  grantUser: z.object({
    action: z.enum(ACTIONS),
    scope: scopeSchema,
    constraints: z.object({ templates: z.array(z.string()).optional(), repos: z.array(z.string()).optional() }).prefault({}),
  }),
  delegate: z.object({
    principalId: z.string(),
    action: z.enum(ACTIONS),
    scope: scopeSchema,
    constraints: z.object({ templates: z.array(z.string()).optional() }).prefault({}),
    delegable: z.boolean().default(false),
    expiresAt: z.string().datetime().nullable().optional(),
  }),
  heartbeat: z.object({ generation: z.number().int(), state: z.enum(WORK_STATES), detail: z.string().max(1000).optional() }),
  claim: z.object({ generation: z.number().int() }),
  gen: z.object({ generation: z.number().int() }),
  runLogs: z.object({ generation: z.number().int(), lines: z.array(z.object({ stream: z.string(), line: z.string() })).max(500) }),
  runEvent: z.object({ generation: z.number().int(), type: z.string(), message: z.string().optional(), data: z.record(z.string(), z.unknown()).optional() }),
  artifact: z.object({ generation: z.number().int(), name: z.string(), contentType: z.string().default("application/octet-stream"), contentBase64: z.string() }),
  complete: z.object({
    generation: z.number().int(),
    outcome: z.enum(["succeeded", "failed", "blocked"]),
    summary: z.string().max(8000).optional(),
    usage: z.record(z.string(), z.unknown()).optional(),
  }),
};

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw badRequest("invalid request body", z.flattenError(r.error));
  return r.data;
}

function actorOf(req: FastifyRequest): Actor {
  if (!req.actor) throw new ApiError(401, "unauthenticated", "missing or invalid bearer token");
  return req.actor;
}

function principalOf(req: FastifyRequest): Principal {
  if (!req.principal) throw new ApiError(401, "unauthenticated", "missing or invalid bearer token");
  return req.principal;
}

function svcOf(req: FastifyRequest): Service {
  return req.svc!;
}

export interface AppOptions {
  instance: Instance;
  driver: RuntimeDriver | null;
  webDist?: string;
  logger?: boolean;
  onStateChange?: () => void;
}

export async function buildApp(opts: AppOptions) {
  const { instance, driver } = opts;
  const app = Fastify({ logger: opts.logger ? { level: "info" } : false, bodyLimit: 4 * 1024 * 1024 });
  await app.register(fastifyWebsocket);

  app.decorateRequest("principal", null);
  app.decorateRequest("actor", null);
  app.decorateRequest("svc", null);
  app.addHook("onRequest", async (req) => {
    const h = req.headers.authorization;
    if (h?.startsWith("Bearer ")) req.principal = await instance.authenticate(h.slice(7).trim());
    else {
      const cookie = readCookie(req, SESSION_COOKIE);
      if (cookie && sameOrigin(req)) req.principal = await instance.authenticate(cookie);
    }
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

  // ---- instance level: who am I, which organizations, browser session
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/api/me", async (req) => instance.me(principalOf(req)));
  app.post("/api/session", async (req, reply) => {
    const { token } = parse(S.session, req.body);
    const p = await instance.authenticate(token);
    if (!p || p.kind !== "human") throw new ApiError(401, "unauthenticated", "invalid or disabled token");
    reply.header("set-cookie", sessionCookie(req, token, SESSION_MAX_AGE));
    return instance.me(p);
  });
  app.delete("/api/session", async (req, reply) => {
    reply.header("set-cookie", sessionCookie(req, "", 0));
    return reply.status(204).send();
  });

  // ---- organization level. People use /api/orgs/<id>/…; agent runtimes keep
  // using /api/… and are confined to their own organization by their token.
  const orgRoutes = async (r: FastifyInstance, o: { people: boolean }) => {
    r.addHook("preHandler", async (req) => {
      const { orgId } = req.params as { orgId?: string };
      const { service, actor } = await instance.resolve(principalOf(req), orgId);
      req.svc = service;
      req.actor = actor;
    });
    if (o.people) r.get("/me", async (req) => svcOf(req).me(actorOf(req)));

  // ---- people and their permissions
  r.get("/roles", async (req) => {
    actorOf(req);
    return { roles: svcOf(req).roles() };
  });
  r.get("/users", async (req) => ({ users: await svcOf(req).listUsers(actorOf(req)) }));
  r.post("/users", async (req, reply) => {
    reply.status(201);
    return changed(await svcOf(req).createUser(actorOf(req), parse(S.createUser, req.body)));
  });
  r.patch<{ Params: { id: string } }>("/users/:id", async (req) =>
    changed(await svcOf(req).updateUser(actorOf(req), req.params.id, parse(S.updateUser, req.body))),
  );
  r.post<{ Params: { id: string } }>("/users/:id/token", async (req) => svcOf(req).resetUserToken(actorOf(req), req.params.id));
  r.post<{ Params: { id: string } }>("/users/:id/grants", async (req, reply) => {
    reply.status(201);
    return changed(await svcOf(req).grantUser(actorOf(req), req.params.id, parse(S.grantUser, req.body)));
  });
  r.delete<{ Params: { id: string; gid: string } }>("/users/:id/grants/:gid", async (req, reply) => {
    await svcOf(req).revokeUserGrant(actorOf(req), req.params.id, req.params.gid);
    changed(null);
    return reply.status(204).send();
  });
  r.get("/catalog", async (req) => svcOf(req).catalog(actorOf(req)));
  r.get("/office/snapshot", async (req) => svcOf(req).snapshot(actorOf(req)));

  // ---- agents
  r.get("/agents", async (req) => ({ agents: await svcOf(req).listAgents(actorOf(req)) }));
  r.post("/agents", async (req, reply) => {
    const out = await svcOf(req).spawn(actorOf(req), parse(S.spawn, req.body));
    reply.status(out.existing ? 200 : 202);
    return changed(out);
  });
  r.get<{ Params: { id: string } }>("/agents/:id", async (req) => svcOf(req).getAgent(actorOf(req), req.params.id));
  r.patch<{ Params: { id: string } }>("/agents/:id", async (req) =>
    changed(await svcOf(req).updateAgent(actorOf(req), req.params.id, parse(S.updateAgent, req.body))),
  );
  r.post<{ Params: { id: string } }>("/agents/:id/pause", async (req) => changed(await svcOf(req).setIntake(actorOf(req), req.params.id, false)));
  r.post<{ Params: { id: string } }>("/agents/:id/resume", async (req) => changed(await svcOf(req).setIntake(actorOf(req), req.params.id, true)));
  for (const op of ["start", "stop", "restart"] as const) {
    r.post<{ Params: { id: string } }>(`/agents/:id/runtime/${op}`, async (req, reply) => {
      reply.status(202);
      return changed(await svcOf(req).setRuntime(actorOf(req), req.params.id, op));
    });
  }
  r.post<{ Params: { id: string } }>("/agents/:id/retire", async (req) =>
    changed(await svcOf(req).retire(actorOf(req), req.params.id, parse(S.retire, req.body).purgeWorkspace)),
  );
  r.get<{ Params: { id: string }; Querystring: { after?: string } }>("/agents/:id/logs", async (req) => ({
    lines: await svcOf(req).logs(actorOf(req), req.params.id, Number(req.query.after ?? 0)),
  }));

  r.put<{ Params: { id: string } }>("/agents/:id/config", async (req) =>
    changed(await svcOf(req).configureAgent(actorOf(req), req.params.id, parse(S.agentConfig, req.body))),
  );

  // ---- credentials (credential.manage; the key is write-only)
  r.get("/credentials", async (req) => ({ credentials: await svcOf(req).listCredentials(actorOf(req)) }));
  r.post("/credentials", async (req, reply) => {
    reply.status(201);
    return svcOf(req).createCredential(actorOf(req), parse(S.credential, req.body));
  });
  r.post<{ Params: { id: string } }>("/credentials/:id/refresh-models", async (req) =>
    svcOf(req).refreshCredentialModels(actorOf(req), req.params.id),
  );
  r.delete<{ Params: { id: string } }>("/credentials/:id", async (req, reply) => {
    await svcOf(req).revokeCredential(actorOf(req), req.params.id);
    changed(null);
    return reply.status(204).send();
  });

  // ---- grants
  r.post("/grants", async (req, reply) => {
    reply.status(201);
    return changed(await svcOf(req).delegate(actorOf(req), parse(S.delegate, req.body)));
  });
  r.delete<{ Params: { id: string } }>("/grants/:id", async (req, reply) => {
    await svcOf(req).revokeGrant(actorOf(req), req.params.id);
    changed(null);
    return reply.status(204).send();
  });

  // ---- tasks
  r.get<{ Querystring: { assignee?: string; status?: string } }>("/tasks", async (req) => ({
    tasks: await svcOf(req).listTasks(actorOf(req), req.query),
  }));
  r.post("/tasks", async (req, reply) => {
    const out = await svcOf(req).createTask(actorOf(req), parse(S.createTask, req.body));
    reply.status(out.existing ? 200 : 201);
    return out;
  });
  r.get<{ Params: { id: string } }>("/tasks/:id", async (req) => svcOf(req).getTask(actorOf(req), req.params.id));
  r.post<{ Params: { id: string } }>("/tasks/:id/assign", async (req) =>
    svcOf(req).assignTask(actorOf(req), req.params.id, parse(S.assign, req.body).assigneeAgentId),
  );
  r.post<{ Params: { id: string } }>("/tasks/:id/cancel", async (req) =>
    svcOf(req).cancelTask(actorOf(req), req.params.id, parse(S.cancel, req.body).reason),
  );
  r.post<{ Params: { id: string } }>("/tasks/:id/retry", async (req) => svcOf(req).retryTask(actorOf(req), req.params.id));
  r.post<{ Params: { id: string } }>("/tasks/:id/review", async (req) => {
    const b = parse(S.review, req.body);
    return svcOf(req).reviewTask(actorOf(req), req.params.id, b.decision, b.note);
  });
  r.get<{ Params: { id: string } }>("/artifacts/:id", async (req, reply) => {
    const a = await svcOf(req).getArtifact(actorOf(req), req.params.id);
    reply.header("content-type", a.contentType).header("x-content-sha256", a.sha256);
    // Artifacts are agent-produced: never let the browser render them as our origin.
    reply.header("content-security-policy", "sandbox").header("x-content-type-options", "nosniff");
    reply.header("content-disposition", `inline; filename="${a.name}"`);
    return reply.send(a.content);
  });

  // ---- harness-facing (agent token + runtime generation)
  r.post("/runtime/heartbeat", async (req) => svcOf(req).heartbeat(actorOf(req), parse(S.heartbeat, req.body)));
  r.post("/runs/claim", async (req, reply) => {
    const out = await svcOf(req).claim(actorOf(req), parse(S.claim, req.body).generation);
    if (!out) return reply.status(204).send();
    return out;
  });
  r.post<{ Params: { id: string } }>("/runs/:id/heartbeat", async (req) =>
    svcOf(req).runHeartbeat(actorOf(req), req.params.id, parse(S.gen, req.body).generation),
  );
  r.post<{ Params: { id: string } }>("/runs/:id/logs", async (req, reply) => {
    const b = parse(S.runLogs, req.body);
    await svcOf(req).runLogs(actorOf(req), req.params.id, b.generation, b.lines);
    return reply.status(204).send();
  });
  r.post<{ Params: { id: string } }>("/runs/:id/events", async (req, reply) => {
    const b = parse(S.runEvent, req.body);
    await svcOf(req).runEvent(actorOf(req), req.params.id, b.generation, b);
    return reply.status(204).send();
  });
  r.post<{ Params: { id: string } }>("/runs/:id/artifacts", async (req, reply) => {
    const b = parse(S.artifact, req.body);
    reply.status(201);
    return svcOf(req).uploadArtifact(actorOf(req), req.params.id, b.generation, {
      name: b.name,
      contentType: b.contentType,
      content: Buffer.from(b.contentBase64, "base64"),
    });
  });
  r.post<{ Params: { id: string } }>("/runs/:id/complete", async (req) => {
    const b = parse(S.complete, req.body);
    return svcOf(req).completeRun(actorOf(req), req.params.id, b.generation, b);
  });

  // ---- audit
  r.get<{ Querystring: { after?: string } }>("/audit", async (req) => ({
    events: await svcOf(req).listAudit(actorOf(req), Number(req.query.after ?? 0)),
  }));

  // ---- events (SSE). Client: GET snapshot -> cursor -> GET /api/events?after=cursor.
  r.get<{ Querystring: { after?: string } }>("/events", async (req, reply) => {
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
    let visible = await svcOf(req).visibleFilter(actor);
    const queue: Array<Parameters<typeof visible>[0]> = [];
    let replaying = true;
    const write = (e: Parameters<typeof visible>[0]) => {
      if (e.seq <= cursor || !visible(e)) return;
      cursor = e.seq;
      res.write(`id: ${e.seq}\nevent: agent-event\ndata: ${JSON.stringify(e)}\n\n`);
    };
    const svc = svcOf(req);
    // Other organizations' events never reach this stream, whatever the policy says.
    const unsubscribe = svc.bus.subscribe((e) => e.orgId === svc.orgId && (replaying ? queue.push(e) : write(e)));
    for (const e of await svcOf(req).eventsAfter(actor, cursor, 5000)) write(e);
    replaying = false;
    for (const e of queue.splice(0)) write(e);
    const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15000);
    const refresh = setInterval(async () => {
      visible = await svcOf(req).visibleFilter(actor).catch(() => visible);
    }, 10000);
    req.raw.on("close", () => {
      unsubscribe();
      clearInterval(ping);
      clearInterval(refresh);
    });
  });

  // ---- terminal: POST mints a one-time ticket (header auth); the WebSocket redeems it.
  const terminals = new Map<string, (reason: string) => void>();
  r.post<{ Params: { id: string } }>("/agents/:id/terminal-sessions", async (req, reply) => {
    if (!opts.driver) throw new ApiError(501, "no_runtime", "no runtime driver configured");
    reply.status(201);
    return svcOf(req).openTerminal(actorOf(req), req.params.id);
  });
  };
  await app.register(orgRoutes, { prefix: "/api", people: false });
  await app.register(orgRoutes, { prefix: "/api/orgs/:orgId", people: true });

  // ---- terminal: the WebSocket redeems the one-time ticket (the ticket names the org).
  const terminals = new Map<string, (reason: string) => void>();
  async function terminalService(sid: string): Promise<Service> {
    const { rows } = await instance.db.query<{ org_id: string }>("SELECT org_id FROM terminal_sessions WHERE id=$1", [sid]);
    if (!rows[0]) throw new ApiError(403, "forbidden", "invalid or expired terminal ticket");
    return instance.org(rows[0].org_id, { includeArchived: true });
  }
  app.get<{ Params: { sid: string }; Querystring: { ticket?: string } }>(
    "/api/terminal-sessions/:sid/attach",
    { websocket: true },
    async (socket, req) => {
      const sid = req.params.sid;
      let target: Awaited<ReturnType<Service["attachTerminal"]>>;
      try {
        target = await (await terminalService(sid)).attachTerminal(sid, req.query.ticket ?? "");
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
        void terminalService(sid).then((s) => s.closeTerminal(sid, reason)).catch(() => {});
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
    for (const { id, orgId, reason } of await instance.terminalsToRevoke()) {
      const close = terminals.get(id);
      if (close) close(reason);
      else await (await instance.org(orgId, { includeArchived: true })).closeTerminal(id, reason);
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
