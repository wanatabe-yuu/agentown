import type { RemotePort } from "./remote-port.ts";
import { chatSubjectSchema, type ChatSubject } from "./chat/subjects.ts";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { ACTIONS, type Actor, EFFORTS, WORK_STATES, authHeaderSchema, termSchema } from "@agentown/core";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { MODEL_MAX } from "./assets.ts";
import { PROVIDERS } from "./providers.ts";
import type { RuntimeDriver } from "./runtime/driver.ts";
import type { Instance, Principal } from "./instance.ts";
import type { Service } from "./service.ts";
import { actorRef, ApiError, badRequest, deny, notFound } from "./util.ts";
import { proposalDiff, SELF_REPO, sourceTarball } from "./selfpatch.ts";
import { OwnerChat } from "./owner-chat.ts";
import { FEED_KINDS, type FeedKind, feed, listTeamMessages, postTeamMessage } from "./conversations.ts";
import { PROPOSAL_KINDS, PROPOSAL_STATUSES, ProposalEngine } from "./proposals.ts";
import { CapabilityGateway } from "./capabilities.ts";
import { Computers, computerRequestSchema } from "./computers.ts";
import { connectorTools, listConnectors, setConnectorCredential } from "./connectors.ts";
import { ownerTools } from "./chat/tools.ts";
import type { ChatModelFactory } from "./chat/types.ts";
import { forwardModel } from "./model-broker.ts";
import { redactProviderKeys, redactedBody } from "./key-redaction.ts";
import { redactLine } from "./util.ts";
import { LANGUAGES } from "./locales.ts";
import { Calendar } from "./calendar.ts";
import { Cleanup } from "./cleanup.ts";

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
    contextLimit: z.number().int().min(8192).max(1000000).nullable(),
    expectedRevision: z.number().int().min(0),
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
    protocol: z.enum(["anthropic", "openai"]).nullable().optional(),
    authHeader: authHeaderSchema.nullable().optional(),
    departments: z.array(z.string()).nullable().default(null),
  }),
  spawn: z.object({
    templateId: z.string(),
    displayName: z.string().min(1).max(40),
    reportsToAgentId: z.string().nullable(),
    departmentId: z.string().optional(),
    teamId: z.string().optional(),
    resources: z.object({ cpu: z.string().max(20).optional(), memory: z.string().max(20).optional() }).optional(),
    idempotencyKey: z.string().max(100).optional(),
    config: agentConfigSchema.optional(),
  }),
  setTeam: z.object({ teamId: z.string().min(1).max(60) }),
  resources: z.object({ cpu: z.string().max(20).optional(), memory: z.string().max(20).optional() }),
  teamMessage: z.object({ text: z.string().trim().min(1).max(4000) }),
  invoke: z.object({ args: z.unknown().optional(), idempotencyKey: z.string().max(100).optional() }).prefault({}),
  proposalQuery: z.object({ status: z.enum(PROPOSAL_STATUSES).optional(), kind: z.enum(PROPOSAL_KINDS).optional(), limit: z.coerce.number().int().min(1).max(300).optional() }),
  decide: z.object({ verdict: z.enum(["approve", "reject"]), note: z.string().max(2000).default("") }),
  feed: z.object({
    kind: z.enum(FEED_KINDS as [FeedKind, ...FeedKind[]]).optional(),
    teamId: z.string().max(60).optional(),
    agentId: z.string().max(60).optional(),
    limit: z.coerce.number().int().min(1).max(300).optional(),
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
    campaignId: z.string().nullable().optional(),
  }),
  createCampaign: z.object({
    projectId: z.string().min(1),
    title: z.string().trim().min(1).max(200),
    goal: z.string().trim().min(1).max(5000),
    mode: z.enum(["auto", "manual"]),
    leadAgentId: z.string().min(1),
    maxFailures: z.number().int().min(1).max(20).optional(),
    maxSteps: z.number().int().min(1).max(100).optional(),
  }).strict(),
  updateCampaign: z.object({
    mode: z.enum(["auto", "manual"]).optional(),
    status: z.enum(["active", "stopped"]).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    goal: z.string().trim().min(1).max(5000).optional(),
    leadAgentId: z.string().min(1).optional(),
    maxFailures: z.number().int().min(1).max(20).optional(),
    maxSteps: z.number().int().min(1).max(100).optional(),
  }).strict(),
  ask: z.object({
    question: z.string().trim().min(1).max(2000),
    options: z.array(z.string().trim().min(1).max(200)).max(6).optional(),
    timeoutMinutes: z.number().int().min(5).max(1440).optional(),
    fallback: z.string().trim().max(1000).optional(),
    /** A login (or anything by hand) the owner does on one of the world's computers. */
    computer: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  }).strict(),
  connectorCredential: z.object({ header: z.string().trim().regex(/^[A-Za-z0-9-]{1,64}$/).default("Authorization"), value: z.string().trim().min(1).max(8000) }).strict(),
  finishCampaign: z.object({ outcome: z.enum(["achieved", "failed"]), summary: z.string().trim().min(1).max(4000) }).strict(),
  assign: z.object({ assigneeAgentId: z.string() }),
  cancel: z.object({ reason: z.string().max(500).default("") }).prefault({}),
  review: z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(2000).default("") }),
  session: z.object({ token: z.string().min(1).max(200) }),
  createOrg: z.object({
    id: z.string(),
    name: z.string().trim().min(1).max(80),
    templateId: z.string(),
    language: z.enum(LANGUAGES).optional(),
    owner: z.union([z.object({ userId: z.string() }), z.object({ displayName: z.string().trim().min(1).max(60) })]),
  }),
  updateOrg: z.object({ name: z.string().trim().min(1).max(80).optional(), ownerUserId: z.string().optional(), archived: z.boolean().optional(), running: z.boolean().optional() }),
  addMember: z.object({ userId: z.string() }),
  orgConfig: z.object({ revision: z.number().int(), doc: z.record(z.string(), z.unknown()) }),
  orgWorld: z.object({ revision: z.number().int(), world: z.record(z.string(), z.unknown()).nullable() }),
  assetQuery: z.object({ kind: z.enum(["model", "texture"]), name: z.string().max(200).default("") }),
  saveTemplate: z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(500).default(""), term: termSchema.optional() }),
  installWorld: z.object({ id: z.string().min(1).max(200) }),
  importTemplate: z.object({
    yaml: z.string().min(1).max(256 * 1024),
    term: termSchema.optional(),
    /** A world bundle's art: the assets/ files its world uses. */
    files: z.array(z.object({ path: z.string().max(64), contentBase64: z.string().max(28_000_000) })).max(64).default([]),
  }),
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
    constraints: z.object({ templates: z.array(z.string()).optional(), repos: z.array(z.string()).optional() }).prefault({}),
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

/** Agents change the world only through the capability gateway, where the owner's approval rules apply. */
function peopleOnly(actor: Actor, tool: string): Actor {
  if (actor.kind === "agent") throw deny(`agents edit the world through the ${tool} tool (agentown tool ${tool}), so the owner's approval rules apply`);
  return actor;
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
  chatModelFactory?: ChatModelFactory;
  /** How pods (agent runtimes, computers) reach this server. */
  runtimeApiUrl?: string;
  /** cloudflared, to give pairing links a temporary public address. */
  cloudflared?: string | null;
  /** The port paired machines reach this server on directly. */
  remote?: RemotePort | null;
}

export async function buildApp(opts: AppOptions) {
  const { instance, driver } = opts;
  // Register keys internally so old logs/chat responses are filtered after a restart too.
  for (const row of (await instance.db.query("SELECT ciphertext FROM credentials")).rows) instance.secrets.open(row.ciphertext);
  // trustProxy "loopback": the public address is a tunnel/proxy on this host (cloudflared), whose
  // X-Forwarded-Proto says https. Anything else (pods, paired machines, the LAN) is not believed.
  const app = Fastify({ logger: opts.logger ? { level: "info" } : false, bodyLimit: 4 * 1024 * 1024, forceCloseConnections: true, trustProxy: "loopback" });
  // Nothing of ours is meant to be framed, sniffed or sent a referrer. Routes may replace the CSP (/player does).
  // A script-src policy for the UI is not set here: it needs a pass over xterm, the 3D office and the video players.
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("x-content-type-options", "nosniff")
      .header("x-frame-options", "DENY")
      .header("referrer-policy", "no-referrer")
      .header("content-security-policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
    if (req.protocol === "https") reply.header("strict-transport-security", "max-age=31536000");
  });
  const ownerChat = new OwnerChat(instance, ownerTools(S), opts.chatModelFactory, opts.onStateChange);
  // Proposals are decided here whatever proposed them; each source's own code carries the decision out.
  const proposals = new ProposalEngine(instance.db);
  proposals.register("chat_action", {
    decide: async (actor, p, verdict) => {
      const { chatId, chatSubject } = p.payload as { chatId: string; chatSubject: ChatSubject };
      return ownerChat.decide(p.org_id, actor, chatId, p.source_id, verdict === "approve", chatSubject);
    },
  });
  proposals.register("question", {
    decide: async (actor, p, verdict, note) => (await instance.org(p.org_id)).answerQuestion(actor, p.id, note, verdict === "reject" && !note),
  });
  proposals.register("task", {
    decide: async (actor, p, verdict, note) => (await instance.org(p.org_id)).reviewTask(actor, String(p.payload.taskId), verdict, note),
  });
  const computers = new Computers(instance, driver, { apiUrl: opts.runtimeApiUrl ?? "http://host.docker.internal:8080", log: (msg, extra) => console.log(`[computers] ${msg}`, extra ?? ""), chatModelFactory: opts.chatModelFactory, cloudflared: opts.cloudflared, remote: opts.remote });
  instance.computers = computers;
  const cleanup = new Cleanup(instance, driver);
  const calendar = new Calendar(instance);
  instance.cleanup = cleanup;
  instance.calendar = calendar;
  if (driver) computers.start();
  app.addHook("onClose", async () => computers.stop());
  const gateway = new CapabilityGateway(instance, proposals, ownerTools(S));
  await ownerChat.recover();
  app.addHook("onClose", async () => ownerChat.close());
  await app.register(fastifyWebsocket);
  app.addHook("onSend", async (req, _reply, payload) => {
    // A computer's runtime fetching its own proxy or VPN config needs it in the clear (only it may ask).
    if (!req.url.startsWith("/api/") || (req.url === "/api/browser/network" && req.principal?.kind === "computer")) return payload;
    if (typeof payload === "string") return redactProviderKeys(payload);
    if (Buffer.isBuffer(payload)) {
      const text = payload.toString("utf8"), filtered = redactProviderKeys(text);
      return filtered === text ? payload : Buffer.from(filtered);
    }
    return payload;
  });

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
    app.log.error({ name: err.name, message: redactLine(err.message) });
    return reply.status(500).send({ error: "internal", message: "internal error" });
  });

  const changed = <T>(v: T): T => {
    opts.onStateChange?.();
    return v;
  };

  // ---- instance level: who am I, which organizations, browser session
  app.get("/healthz", async () => ({ ok: true }));
  // A computer's player: a video file or HLS stream full-window (its stream and camera apps open it).
  // The player page a computer's browser opens for videos and camera feeds (/api/browser/…: paired machines reach it too).
  const player = async (req: FastifyRequest<{ Querystring: { src?: string } }>, reply: FastifyReply) => {
    const src = String(req.query.src ?? "");
    if (!/^https?:\/\//i.test(src) || src.length > 1000) throw badRequest("src must be an http(s) link");
    reply.type("text/html; charset=utf-8").header("content-security-policy", "default-src 'none'; media-src * blob: data:; img-src * data:; connect-src *; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'self'; worker-src blob:");
    return `<!doctype html><meta charset="utf-8"><title>Player</title><style>html,body{margin:0;height:100%;background:#000}video{width:100%;height:100%;object-fit:contain}</style>` +
      `<video id="v" autoplay muted playsinline controls loop></video><script src="player.js"></script>` +
      `<script>const src=${JSON.stringify(src).replace(/</g, "\\u003c")};const v=document.getElementById("v");` +
      `if(/\\.m3u8(\\?|#|$)/i.test(src)&&window.Hls&&Hls.isSupported()){const h=new Hls({capLevelToPlayerSize:true});h.loadSource(src);h.attachMedia(v)}else v.src=src;</script>`;
  };
  app.get("/player", player);
  app.get("/api/browser/player", player);
  // hls.js, built into the web UI (pinned in the lockfile) and served from here, never from a CDN. The page's relative
  // "player.js" lands on whichever of these two its own address is next to.
  let hls: Buffer | undefined;
  const hlsJs = async (_req: FastifyRequest, reply: FastifyReply) => {
    const file = opts.webDist && join(opts.webDist, "vendor/hls.min.js");
    if (!file || !existsSync(file)) throw notFound("the player script (build the web UI)");
    hls ??= readFileSync(file);
    return reply.type("text/javascript; charset=utf-8").header("cache-control", "public, max-age=3600").send(hls);
  };
  app.get("/player.js", hlsJs);
  app.get("/api/browser/player.js", hlsJs);
  app.get("/api/me", async (req) => instance.me(principalOf(req)));

  // ---- team runtimes: list their members and start a session (own token) for each.
  const runtimeOf = (req: FastifyRequest) => {
    const p = principalOf(req);
    if (p.kind !== "runtime") throw new ApiError(403, "forbidden", "team runtime token required");
    return p;
  };
  app.get("/api/runtime/team", async (req) => {
    const p = runtimeOf(req);
    return (await instance.org(p.orgId)).teamHello(p.teamId);
  });
  app.post<{ Params: { id: string } }>("/api/runtime/team/members/:id/session", async (req) => {
    const p = runtimeOf(req);
    return (await instance.org(p.orgId)).memberSession(p.teamId, req.params.id);
  });
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

  // ---- instance admin: organizations and their templates
  app.get("/api/templates", async (req) => ({ templates: await instance.listTemplates(principalOf(req)) }));
  // A world bundle: its YAML and the art it uses (base64), up to 100 MB of art.
  app.post("/api/templates", { bodyLimit: 140 * 1024 * 1024 }, async (req, reply) => {
    reply.status(201);
    const body = parse(S.importTemplate, req.body);
    return instance.importTemplate(principalOf(req), body.yaml, body.term, body.files.map((f) => ({ path: f.path, content: Buffer.from(f.contentBase64, "base64") })));
  });
  app.get("/api/marketplace", async (req) => instance.listMarketplace(principalOf(req)));
  app.post("/api/marketplace/install", async (req, reply) => {
    reply.status(201);
    return instance.installFromMarketplace(principalOf(req), parse(S.installWorld, req.body).id);
  });
  app.get<{ Params: { id: string } }>("/api/templates/:id/export", async (req, reply) => {
    const yaml = await instance.exportTemplate(principalOf(req), req.params.id);
    reply.header("content-type", "text/yaml; charset=utf-8").header("content-disposition", `attachment; filename="${req.params.id.replace(/[^a-z0-9-]/gi, "")}.yaml"`);
    return reply.send(yaml);
  });
  app.delete<{ Params: { id: string } }>("/api/templates/:id", async (req, reply) => {
    await instance.deleteTemplate(principalOf(req), req.params.id);
    return reply.status(204).send();
  });
  app.get("/api/admin/orgs", async (req) => ({ orgs: await instance.listOrgs(principalOf(req)) }));
  app.get("/api/admin/users", async (req) => ({ users: await instance.listAccounts(principalOf(req)) }));
  app.post("/api/admin/orgs", async (req, reply) => {
    reply.status(201);
    return changed(await instance.createOrg(principalOf(req), parse(S.createOrg, req.body)));
  });
  app.patch<{ Params: { id: string } }>("/api/admin/orgs/:id", async (req) =>
    changed(await instance.updateOrg(principalOf(req), req.params.id, parse(S.updateOrg, req.body))),
  );

  // ---- organization level. People use /api/orgs/<id>/…; agent runtimes keep
  // using /api/… and are confined to their own organization by their token.
  const orgRoutes = async (r: FastifyInstance, o: { people: boolean }) => {
    r.addHook("preHandler", async (req) => {
      const { orgId } = req.params as { orgId?: string };
      const { service, actor } = await instance.resolve(principalOf(req), orgId);
      // While it stops or is paused, people can only look; agents may still finish the runs they have.
      if (actor.kind === "human" && req.method !== "GET" && req.method !== "HEAD" && service.runState !== "running") {
        throw new ApiError(409, "org_paused", service.runState === "pausing" ? "the organization is stopping: wait until it has stopped, then play it again" : service.runState === "starting" ? "the organization starts once the one running now has stopped" : "the organization is paused: play it to make changes");
      }
      req.svc = service;
      req.actor = actor;
    });
    r.all<{ Params: { protocol: string; "*": string } }>("/runtime/llm/:protocol/*", async (req, reply) =>
      forwardModel(svcOf(req), actorOf(req), req, reply, req.params.protocol, req.params["*"]));
    if (o.people) {
      r.addHook("onSend", async (req, reply) => {
        if ((req.routeOptions.url?.includes("/owner-chats") || req.routeOptions.url?.includes("/entity-chats"))) reply.header("cache-control", "no-store");
      });
      r.get<{ Querystring: { archived?: string } }>("/owner-chats", async req => {
        if (req.query.archived !== undefined && !["true", "false"].includes(req.query.archived)) throw badRequest("Invalid archived filter.");
        return ownerChat.list(svcOf(req).orgId, actorOf(req), req.query.archived === "true");
      });
      r.post("/owner-chats", async (req, reply) => {
        reply.status(201);
        return ownerChat.create(svcOf(req).orgId, actorOf(req), req.body);
      });
      r.get<{ Params: { id: string }; Querystring: { before?: string } }>("/owner-chats/:id", async req => {
        const before = req.query.before ? Number(req.query.before) : undefined;
        if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw badRequest("Invalid history cursor.");
        return ownerChat.view(svcOf(req).orgId, actorOf(req), req.params.id, before);
      });
      r.put<{ Params: { id: string } }>("/owner-chats/:id/config", async req => ownerChat.configure(svcOf(req).orgId, actorOf(req), req.params.id, req.body));
      r.put<{ Params: { id: string } }>("/owner-chats/:id/archive", async req => ownerChat.lifecycle(svcOf(req).orgId, actorOf(req), req.params.id,
        parse(z.object({ archived: z.boolean() }).strict(), req.body).archived ? "archive" : "restore"));
      r.delete<{ Params: { id: string } }>("/owner-chats/:id", async req => ownerChat.lifecycle(svcOf(req).orgId, actorOf(req), req.params.id, "delete"));
      r.post<{ Params: { id: string } }>("/owner-chats/:id/messages", async req => ownerChat.start(svcOf(req).orgId, actorOf(req), req.params.id,
        parse(z.object({ requestId: z.string().min(8).max(100), text: z.string().trim().min(1).max(50000) }).strict(), req.body)));
      r.post<{ Params: { id: string } }>("/owner-chats/:id/compact", async req => ownerChat.start(svcOf(req).orgId, actorOf(req), req.params.id,
        { ...parse(z.object({ requestId: z.string().min(8).max(100) }).strict(), req.body), compact: true }));
      r.post<{ Params: { id: string } }>("/owner-chats/:id/stop", async req => ownerChat.stop(svcOf(req).orgId, actorOf(req), req.params.id));
      r.post<{ Params: { id: string; aid: string } }>("/owner-chats/:id/actions/:aid", async req => ownerChat.decide(svcOf(req).orgId, actorOf(req), req.params.id, req.params.aid,
        parse(z.object({ approve: z.boolean() }).strict(), req.body).approve));
      // Where any placed object (talking or not) came up in the owner's conversations.
      r.get<{ Params: { id: string } }>("/object-refs/:id", async req => ownerChat.objectRefs(svcOf(req).orgId, actorOf(req), req.params.id));
      r.get<{ Params: { type: string; subjectId: string }; Querystring: { archived?: string } }>("/entity-chats/:type/:subjectId", async req => {
        if (req.query.archived !== undefined && !["true", "false"].includes(req.query.archived)) throw badRequest("Invalid archived filter.");
        return ownerChat.list(svcOf(req).orgId, actorOf(req), req.query.archived === "true", parse(chatSubjectSchema, { type: req.params.type, id: req.params.subjectId }));
      });
      r.post<{ Params: { type: string; subjectId: string } }>("/entity-chats/:type/:subjectId", async (req, reply) => {
        reply.status(201);
        return ownerChat.create(svcOf(req).orgId, actorOf(req), req.body, parse(chatSubjectSchema, { type: req.params.type, id: req.params.subjectId }));
      });
      r.get<{ Params: { id: string; type: string; subjectId: string }; Querystring: { before?: string } }>("/entity-chats/:type/:subjectId/:id", async req => {
        const before = req.query.before ? Number(req.query.before) : undefined;
        if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw badRequest("Invalid history cursor.");
        return ownerChat.view(svcOf(req).orgId, actorOf(req), req.params.id, before, parse(chatSubjectSchema, { type: req.params.type, id: req.params.subjectId }));
      });
      r.put<{ Params: { id: string; type: string; subjectId: string } }>("/entity-chats/:type/:subjectId/:id/config", async req => ownerChat.configure(svcOf(req).orgId, actorOf(req), req.params.id, req.body, parse(chatSubjectSchema, { type: req.params.type, id: req.params.subjectId })));
      r.put<{ Params: { id: string; type: string; subjectId: string } }>("/entity-chats/:type/:subjectId/:id/archive", async req => ownerChat.lifecycle(svcOf(req).orgId, actorOf(req), req.params.id,
        parse(z.object({ archived: z.boolean() }).strict(), req.body).archived ? "archive" : "restore", parse(chatSubjectSchema, { type: req.params.type, id: req.params.subjectId })));
      r.delete<{ Params: { id: string; type: string; subjectId: string } }>("/entity-chats/:type/:subjectId/:id", async req => ownerChat.lifecycle(svcOf(req).orgId, actorOf(req), req.params.id, "delete", parse(chatSubjectSchema, { type: req.params.type, id: req.params.subjectId })));
      r.post<{ Params: { id: string; type: string; subjectId: string } }>("/entity-chats/:type/:subjectId/:id/messages", async req => ownerChat.start(svcOf(req).orgId, actorOf(req), req.params.id,
        parse(z.object({ requestId: z.string().min(8).max(100), text: z.string().trim().min(1).max(50000) }).strict(), req.body), parse(chatSubjectSchema, { type: req.params.type, id: req.params.subjectId })));
      r.post<{ Params: { id: string; type: string; subjectId: string } }>("/entity-chats/:type/:subjectId/:id/compact", async req => ownerChat.start(svcOf(req).orgId, actorOf(req), req.params.id,
        { ...parse(z.object({ requestId: z.string().min(8).max(100) }).strict(), req.body), compact: true }, parse(chatSubjectSchema, { type: req.params.type, id: req.params.subjectId })));
      r.post<{ Params: { id: string; type: string; subjectId: string } }>("/entity-chats/:type/:subjectId/:id/stop", async req => ownerChat.stop(svcOf(req).orgId, actorOf(req), req.params.id, parse(chatSubjectSchema, { type: req.params.type, id: req.params.subjectId })));
      r.post<{ Params: { id: string; aid: string; type: string; subjectId: string } }>("/entity-chats/:type/:subjectId/:id/actions/:aid", async req => ownerChat.decide(svcOf(req).orgId, actorOf(req), req.params.id, req.params.aid,
        parse(z.object({ approve: z.boolean() }).strict(), req.body).approve, parse(chatSubjectSchema, { type: req.params.type, id: req.params.subjectId })));
      r.get("/me", async (req) => svcOf(req).me(actorOf(req)));
      // The organization's structure (owner only), and saving it as a template.
      r.get("/config", async (req) => svcOf(req).getConfig(actorOf(req)));
      r.put("/kernel", async (req) =>
        changed(await svcOf(req).setKernelSettings(actorOf(req), parse(z.object({ worldEdits: z.enum(["approve", "auto"]).optional(), approver: z.enum(["owner", "lead"]).optional() }).strict(), req.body))),
      );
      r.put("/language", async (req) => changed(await svcOf(req).setLanguage(actorOf(req), parse(z.object({ language: z.enum(LANGUAGES) }), req.body).language)));
      r.put("/config", async (req) => changed(await instance.updateOrgConfig(svcOf(req), actorOf(req), parse(S.orgConfig, req.body))));
      r.post("/templates", async (req, reply) => {
        reply.status(201);
        return instance.saveOrgAsTemplate(principalOf(req), svcOf(req), actorOf(req), parse(S.saveTemplate, req.body));
      });

      // The world (org.design) and its art. Uploads are raw bytes with their own size limit.
      r.get("/world", async (req) => svcOf(req).getWorld(actorOf(req)));
      r.put("/world", async (req) => changed(await instance.updateOrgWorld(svcOf(req), peopleOnly(actorOf(req), "replace_world"), parse(S.orgWorld, req.body))));
      r.addContentTypeParser(["application/octet-stream", "model/gltf-binary", "image/png", "image/jpeg", "image/webp"], { parseAs: "buffer", bodyLimit: MODEL_MAX + 1 }, (_req, body, done) =>
        done(null, body),
      );
      r.get("/assets", async (req) => svcOf(req).listAssets(actorOf(req)));
      r.post("/assets", { bodyLimit: MODEL_MAX + 1 }, async (req, reply) => {
        if (!Buffer.isBuffer(req.body)) throw badRequest("send the file's bytes (content-type application/octet-stream)");
        const q = parse(S.assetQuery, req.query);
        reply.status(201);
        return svcOf(req).uploadAsset(peopleOnly(actorOf(req), "upload_asset"), { kind: q.kind, name: q.name, content: req.body });
      });
      r.get<{ Params: { id: string } }>("/assets/:id", async (req, reply) => {
        const a = await svcOf(req).getAsset(actorOf(req), req.params.id);
        if (req.headers["if-none-match"] === `"${a.sha256}"`) return reply.status(304).send();
        // Content is immutable (a new upload is a new id) and only ever art: never render it as a page.
        reply
          .header("content-type", a.contentType)
          .header("cache-control", "private, max-age=31536000, immutable")
          .header("etag", `"${a.sha256}"`)
          .header("x-content-type-options", "nosniff")
          .header("content-security-policy", "default-src 'none'; sandbox")
          .header("content-disposition", "inline");
        return reply.send(a.content);
      });
      r.delete<{ Params: { id: string } }>("/assets/:id", async (req, reply) => {
        await svcOf(req).deleteAsset(actorOf(req), req.params.id);
        return reply.status(204).send();
      });
    }

  // ---- people and their permissions
  r.get("/roles", async (req) => {
    actorOf(req);
    return { roles: svcOf(req).roles() };
  });
  r.get("/users", async (req) => ({ users: await svcOf(req).listUsers(actorOf(req)) }));
  r.post("/users/members", async (req) => changed(await svcOf(req).addMember(actorOf(req), parse(S.addMember, req.body).userId)));
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
  r.get("/capabilities", async (req) => svcOf(req).me(actorOf(req)));
  r.get("/office/snapshot", async (req) => svcOf(req).snapshot(actorOf(req)));
  // Doing something with an object: the owner (for themself or by asking an agent), or an agent for itself.
  r.post<{ Params: { id: string } }>("/objects/:id/actions", async (req) => {
    const b = parse(z.object({ action: z.string().min(1).max(64), agentId: z.string().min(1).max(64).optional() }).strict(), req.body);
    return svcOf(req).objectAction(actorOf(req), req.params.id, { action: b.action }, b.agentId ? { type: "agent", id: b.agentId } : undefined);
  });

  // ---- the cleaning robot and the trash can
  r.get("/cleanup", async (req) => cleanup.view(svcOf(req), actorOf(req)));
  r.post("/cleanup/sweep", async (req) => cleanup.sweepNow(svcOf(req), actorOf(req), parse(z.object({ dryRun: z.boolean().default(false) }).strict(), req.body ?? {}).dryRun));
  r.post("/cleanup/empty", async (req) => cleanup.emptyNow(svcOf(req), actorOf(req)));
  r.post<{ Params: { id: string } }>("/cleanup/items/:id/restore", async (req) => cleanup.restore(svcOf(req), actorOf(req), req.params.id));

  // ---- the wall calendar
  r.get<{ Querystring: { from?: string; to?: string } }>("/calendar", async (req) => calendar.view(svcOf(req), actorOf(req), req.query.from ?? "", req.query.to ?? ""));
  r.post("/schedules", async (req, reply) => {
    reply.status(201);
    return calendar.create(svcOf(req), actorOf(req), req.body);
  });
  r.put<{ Params: { id: string } }>("/schedules/:id", async (req) => calendar.update(svcOf(req), actorOf(req), req.params.id, req.body));
  r.delete<{ Params: { id: string } }>("/schedules/:id", async (req, reply) => {
    await calendar.remove(svcOf(req), actorOf(req), req.params.id);
    return reply.status(204).send();
  });

  // ---- agents
  r.get("/agents", async (req) => ({ agents: await svcOf(req).listAgents(actorOf(req)) }));
  r.post("/agents", async (req, reply) => {
    const out = await svcOf(req).spawn(actorOf(req), parse(S.spawn, req.body));
    reply.status(out.existing ? 200 : 202);
    return changed(out);
  });
  r.get<{ Params: { id: string } }>("/agents/:id", async (req) => svcOf(req).getAgent(actorOf(req), req.params.id));
  r.put<{ Params: { id: string } }>("/agents/:id/team", async (req) =>
    changed(await svcOf(req).setTeam(actorOf(req), req.params.id, parse(S.setTeam, req.body).teamId)),
  );
  r.put<{ Params: { id: string } }>("/agents/:id/resources", async (req) =>
    changed(await svcOf(req).setResources(actorOf(req), req.params.id, parse(S.resources, req.body))),
  );
  r.get("/teams", async (req) => ({ teams: await svcOf(req).listTeams(actorOf(req)) }));

  // ---- capability system (registry, discovery, gateway) and proposals
  r.get("/tools", async (req) => ({ tools: await gateway.discover(svcOf(req), actorOf(req)) }));
  // ---- self-patching: this install's own source, and code proposals' diffs for review
  r.get("/code/source", async (req, reply) => {
    const actor = actorOf(req);
    await svcOf(req).require(actor, "code.read", { repoId: SELF_REPO, ...(actor.kind === "agent" ? { agentId: actor.id } : {}) }, { auditAs: "code.read" });
    const file = sourceTarball();
    if (!existsSync(file)) throw notFound("source (this build was packaged without it)");
    return reply.header("content-type", "application/gzip").header("content-disposition", 'attachment; filename="agentown-source.tar.gz"').send(createReadStream(file));
  });
  r.get<{ Params: { id: string } }>("/code/proposals/:id/diff", async (req, reply) => {
    const svc = svcOf(req);
    const actor = actorOf(req);
    if (!(actor.kind === "human" && actor.owner)) throw deny("only the owner reviews code proposals");
    return reply.header("content-type", "text/plain; charset=utf-8").header("content-security-policy", "sandbox").send(await proposalDiff(svc.db, svc.orgId, req.params.id));
  });
  // ---- the world's computers: listed for everyone, watched and used by hand by the owner (and designers).
  r.get("/computers", async (req) => ({ computers: await computers.listAll(svcOf(req)) }));
  r.get<{ Params: { id: string } }>("/computers/:id", async (req) => computers.status(svcOf(req), req.params.id));
  r.post<{ Params: { id: string } }>("/computers/:id/stop", async (req) => {
    if (!(await computers.mayWatch(svcOf(req), actorOf(req)))) throw deny("only the owner, or people who may design the world, turn computers off");
    return computers.shutDown(svcOf(req), req.params.id);
  });
  r.put<{ Params: { id: string } }>("/computers/:id/network", async (req) =>
    computers.setNetwork(svcOf(req), actorOf(req), req.params.id, parse(z.object({ secret: z.string().min(1).max(8000).nullable() }), req.body).secret));
  r.post<{ Params: { id: string } }>("/computers/:id/pair", async (req) => computers.pair(svcOf(req), actorOf(req), req.params.id));
  r.delete<{ Params: { id: string } }>("/computers/:id/pair", async (req) => computers.unpair(svcOf(req), actorOf(req), req.params.id));
  r.get<{ Params: { id: string } }>("/computers/:id/requests", async (req) => ({ requests: await computers.requests(svcOf(req), req.params.id) }));
  // Give a computer work. Agents may; among people, those who may use its screen (others chat with it).
  r.post<{ Params: { id: string } }>("/computers/:id/requests", async (req) => {
    const actor = actorOf(req);
    if (actor.kind === "human" && !(await computers.mayWatch(svcOf(req), actor))) throw deny("only the owner, or people who may design the world, give the computers work; others chat with them");
    return computers.request(svcOf(req), req.params.id, actorRef(actor), parse(computerRequestSchema, req.body));
  });
  r.get<{ Params: { id: string } }>("/computers/:id/screen", { websocket: true }, (socket, req) => {
    // Mouse and keyboard reach a logged-in browser: only from our own pages.
    const origin = req.headers.origin;
    if (origin && (() => { try { return new URL(origin).host !== req.headers.host; } catch { return true; } })()) return socket.close(4403, "cross-origin");
    computers.watch(svcOf(req), actorOf(req), req.params.id, socket).catch((err) => {
      try {
        socket.send(JSON.stringify({ t: "status", state: "error", detail: (err as Error).message }));
      } catch {}
      socket.close(4403, "denied");
    });
  });
  // ---- connectors (MCP servers of the world): their credentials are the owner's.
  r.get("/connectors", async (req) => ({ connectors: await listConnectors(svcOf(req)) }));
  r.get<{ Params: { id: string } }>("/connectors/:id/tools", async (req) => ({ tools: await connectorTools(svcOf(req), req.params.id) }));
  r.put<{ Params: { id: string } }>("/connectors/:id/credential", async (req) =>
    setConnectorCredential(svcOf(req), actorOf(req), req.params.id, parse(S.connectorCredential, req.body)));
  r.delete<{ Params: { id: string } }>("/connectors/:id/credential", async (req) => setConnectorCredential(svcOf(req), actorOf(req), req.params.id, null));
  // Room for a base64 model (upload_asset) or a whole world.
  r.post<{ Params: { id: string } }>("/tools/:id/invoke", { bodyLimit: Math.ceil(MODEL_MAX * 1.4) + 4096 }, async (req, reply) => {
    const body = parse(S.invoke, req.body);
    const svc = svcOf(req);
    const actor = actorOf(req);
    // Called while the agent works on a task: the proposal remembers it, and the task waits for the decision.
    const taskId = actor.kind === "agent"
      ? (await svc.db.query<{ task_id: string }>("SELECT task_id FROM task_runs WHERE agent_id=$1 AND status='running' ORDER BY started_at DESC LIMIT 1", [actor.id])).rows[0]?.task_id ?? null
      : null;
    const out = await gateway.invoke(svc, actor, req.params.id, body.args, body.idempotencyKey, { taskId });
    reply.status(out.status === "pending" ? 202 : 200);
    return changed(out);
  });
  r.get<{ Querystring: { status?: string; kind?: string; limit?: string } }>("/proposals", async (req) => {
    const q = parse(S.proposalQuery, req.query);
    return { proposals: await proposals.list(svcOf(req).orgId, actorOf(req), q) };
  });
  r.post<{ Params: { id: string } }>("/proposals/:id/decide", async (req) => {
    const b = parse(S.decide, req.body);
    return changed(await proposals.decide(svcOf(req).orgId, actorOf(req), req.params.id, b.verdict, b.note));
  });
  r.get<{ Params: { id: string }; Querystring: { after?: string } }>("/teams/:id/messages", async (req) =>
    listTeamMessages(svcOf(req), actorOf(req), req.params.id, Number(req.query.after ?? 0)),
  );
  r.post<{ Params: { id: string } }>("/teams/:id/messages", async (req, reply) => {
    reply.status(201);
    return changed(await postTeamMessage(svcOf(req), actorOf(req), req.params.id, parse(S.teamMessage, req.body).text));
  });
  r.get<{ Querystring: { kind?: string; teamId?: string; agentId?: string; limit?: string } }>("/feed", async (req) => {
    const q = parse(S.feed, req.query);
    return feed(svcOf(req), actorOf(req), q);
  });
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

  r.put<{ Params: { id: string } }>("/agents/:id/config", async (req) => {
    const { expectedRevision, ...change } = parse(S.agentConfig, req.body);
    const runId = req.headers["x-agentown-run-id"];
    const execution = runId === undefined ? {} : z.object({ runId: z.string().min(1).max(100), generation: z.coerce.number().int().positive() }).parse({ runId, generation: req.headers["x-agentown-generation"] });
    return changed(await svcOf(req).configureAgent(actorOf(req), req.params.id, change, { expectedRevision, ...execution }));
  });

  // ---- credentials (credential.manage; the key is write-only)
  r.get("/credentials", async (req) => ({ credentials: await svcOf(req).listCredentials(actorOf(req)) }));
  r.post("/credentials", async (req, reply) => {
    reply.status(201);
    return svcOf(req).createCredential(actorOf(req), parse(S.credential, req.body));
  });
  r.post<{ Params: { id: string } }>("/credentials/:id/refresh-models", async (req) =>
    svcOf(req).refreshCredentialModels(actorOf(req), req.params.id),
  );
  r.put<{ Params: { id: string } }>("/credentials/:id/connection", async req => changed(await svcOf(req).updateCredentialConnection(actorOf(req), req.params.id,
    parse(z.object({ revision: z.number().int().positive(), baseUrl: z.string().trim().min(1).max(500), protocol: z.enum(["anthropic", "openai"]), authHeader: authHeaderSchema, workspaceId: z.string().trim().max(120).nullable().optional() }).strict(), req.body))));
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
  r.get<{ Querystring: { projectId?: string } }>("/campaigns", async (req) => ({ campaigns: await svcOf(req).listCampaigns(actorOf(req), { projectId: req.query.projectId }) }));
  r.post("/campaigns", async (req, reply) => {
    reply.status(201);
    return changed(await svcOf(req).createCampaign(actorOf(req), parse(S.createCampaign, req.body)));
  });
  r.get<{ Params: { id: string } }>("/campaigns/:id", async (req) => svcOf(req).getCampaign(actorOf(req), req.params.id));
  r.patch<{ Params: { id: string } }>("/campaigns/:id", async (req) => changed(await svcOf(req).updateCampaign(actorOf(req), req.params.id, parse(S.updateCampaign, req.body))));
  r.post<{ Params: { id: string } }>("/campaigns/:id/finish", async (req) => {
    const b = parse(S.finishCampaign, req.body);
    return changed(await svcOf(req).finishCampaign(actorOf(req), req.params.id, b.outcome, b.summary));
  });
  r.get<{ Querystring: { assignee?: string; status?: string; campaign?: string } }>("/tasks", async (req) => ({
    tasks: await svcOf(req).listTasks(actorOf(req), req.query),
  }));
  r.post("/tasks", async (req, reply) => {
    const out = await svcOf(req).createTask(actorOf(req), parse(S.createTask, req.body));
    reply.status(out.existing ? 200 : 201);
    return out;
  });
  r.get<{ Params: { id: string } }>("/tasks/:id", async (req) => svcOf(req).getTask(actorOf(req), req.params.id));
  r.post<{ Params: { id: string } }>("/tasks/:id/ask", async (req, reply) => {
    reply.status(201);
    return changed(await svcOf(req).askOwner(actorOf(req), req.params.id, parse(S.ask, req.body)));
  });
  r.get<{ Params: { id: string } }>("/tasks/:id/progress", async (req, reply) => {
    reply.header("cache-control", "no-store");
    return svcOf(req).taskProgress(actorOf(req), req.params.id);
  });
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
    // Text artifacts are UTF-8. Without a charset Safari may interpret their
    // Vietnamese bytes as Windows-1252, even though storage is intact.
    const contentType = /^(text\/|application\/(?:json|xml)(?:;|$))/i.test(a.contentType)
      ? `${a.contentType.replace(/;\s*charset=[^;]+/ig, "")}; charset=utf-8` : a.contentType;
    reply.header("content-type", contentType).header("x-content-sha256", a.sha256);
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
      res.write(`id: ${e.seq}\nevent: agent-event\ndata: ${redactProviderKeys(JSON.stringify(e))}\n\n`);
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
  r.post<{ Params: { id: string } }>("/agents/:id/terminal-sessions", async (req, reply) => {
    if (!opts.driver) throw new ApiError(501, "no_runtime", "no runtime driver configured");
    reply.status(201);
    return svcOf(req).openTerminal(actorOf(req), req.params.id);
  });
  };
  await app.register(orgRoutes, { prefix: "/api", people: false });
  await app.register(orgRoutes, { prefix: "/api/orgs/:orgId", people: true });

  // ---- a computer's pod connects its browser here (its own token; see computers.ts).
  app.get("/api/browser/bridge", { websocket: true }, (socket, req) => {
    const p = req.principal;
    if (p?.kind !== "computer") return socket.close(4401, "computer token required");
    void computers.attachBridge(p.orgId, p.objectId, socket);
  });
  // A paired machine checks it can reach Agentown here (no login).
  app.get("/api/browser/hello", async () => ({ agentown: true }));
  // A computer's runtime asks how to connect (its proxy or VPN) and, on a paired machine, fetches its image.
  app.get("/api/browser/network", async (req) => {
    const p = req.principal;
    if (p?.kind !== "computer") throw deny("computer token required");
    return computers.networkFor(p.orgId, p.objectId);
  });
  app.get("/api/browser/image", async (req, reply) => {
    if (req.principal?.kind !== "computer") throw deny("computer token required");
    const file = resolvePath(process.env.AGENTOWN_STATE_DIR ?? ".agentown", "images", "browser.tar.gz");
    if (!existsSync(file)) throw notFound("computer image (this install keeps none for paired machines)");
    return reply.type("application/gzip").send(createReadStream(file));
  });
  // Pairing another machine: the one command it runs fetches this script, which claims the link once.

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
      const filtered = Readable.fromWeb(redactedBody(Readable.toWeb(stdout) as ReadableStream<Uint8Array>) as any);
      filtered.on("data", (d: Buffer) => socket.send(JSON.stringify({ type: "output", data: d.toString("utf8") })));
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
        // A team runtime holds several members: open the shell in this member's own home (agent ids are DNS labels).
        const home = `/workspace/members/${target.agentId}`;
        exec = await driver!.exec(target.namespace, target.pod, ["/bin/sh", "-c", `cd ${home} 2>/dev/null && export HOME=${home}/home; exec /bin/sh -l`], {
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

  return { app, recheckTerminals, terminals, ownerChat, cleanup, calendar };
}
