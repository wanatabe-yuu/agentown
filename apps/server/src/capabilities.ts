import { ACTIONS, type Action, type Actor, authorize, EFFORTS } from "@agentown/core";
import { z } from "zod";
import { needsApproval, patchDocument } from "./chat/tools.ts";
import type { ChatTool, ToolContext } from "./chat/types.ts";
import { postTeamMessage } from "./conversations.ts";
import type { Instance } from "./instance.ts";
import { openProposal, type ProposalEngine, type ProposalRow, recordProposal } from "./proposals.ts";
import { BROWSER_KEYS, computerRequestSchema } from "./computers.ts";
import { callConnector, connectorAsks, connectorTools, listConnectors } from "./connectors.ts";
import { queuePatch } from "./selfpatch.ts";
import type { Service } from "./service.ts";
import { actorRef, ApiError, badRequest, deny, newId, notFound } from "./util.ts";

/**
 * Capability System: every tool is described once (registry), offered to the
 * principals allowed to use it (discovery) and called through one door (gateway)
 * that validates, authorizes, asks the Proposal Engine whether someone must
 * approve, executes and audits. It is independent of where agents run: a team
 * runtime, a chat, or any other runtime reaches it over HTTP.
 */

export type Effect = "read" | "write" | "destructive";

export interface CapabilityDescriptor {
  id: string;
  title: string;
  description: string;
  input: z.ZodType;
  /** The permission a caller needs somewhere in the organization; "owner" = owner only; null = everyone. */
  permission: Action | "owner" | null;
  effect: Effect;
  /** never: runs at once. policy: the approval rules decide. always: someone approves every call. */
  approval: "never" | "policy" | "always";
  /** kernel: executed by the server. runtime-local: runs inside the caller's runtime (described for discovery only). */
  executor: "kernel" | "runtime-local";
  /** For "policy": does this particular call need approval? */
  requiresApproval?: (args: any) => boolean;
  /** Same, when the answer depends on the organization (a connector's own setting). */
  requiresApprovalIn?: (service: Service, args: any) => boolean;
  /**
   * May the caller make this particular call itself? When not, the call never bounces:
   * it becomes a request whoever approves (the owner, or the lead) carries out themself.
   */
  allowed?: (ctx: Omit<ToolContext, "idempotencyKey">, args: any) => Promise<boolean>;
  execute?: (ctx: ToolContext, args: any) => Promise<unknown>;
}

const TOOL_PERMISSION: Record<string, Action | "owner" | null> = {
  inspect: "org.view",
  patch_world: "org.design",
  replace_world: "org.design",
  patch_config: "owner",
  create_task: "task.create",
  task_action: "task.assign",
  spawn_agent: "agent.spawn",
  update_agent: "agent.update",
  configure_agent: "agent.configure",
  agent_action: "runtime.control",
  retire_agent: "agent.retire",
  update_person: "user.manage",
  grant_person: "user.manage",
  revoke_permission: "permission.delegate",
  delegate_permission: "permission.delegate",
  credential_action: "credential.manage",
  delete_asset: "org.design",
  upload_asset: "org.design",
};

/**
 * World tools never bounce off a missing permission: a caller without
 * org.design proposes the change and the owner applies it. With org.design the
 * kernel setting decides: "approve" (default) waits for the owner, "auto" applies.
 */
const WORLD_TOOLS = new Set(["patch_world", "replace_world", "upload_asset"]);

const ORG_LEVEL = new Set<Action>(["org.design", "audit.view", "user.manage", "credential.manage"]);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a day like 2026-10-20");
const scopeSchema = z.union([
  z.object({ kind: z.enum(["self", "direct-reports", "descendants", "team", "department", "org"]) }).strict(),
  z.object({ kind: z.enum(["agents", "projects", "departments"]), ids: z.array(z.string().min(1).max(64)).min(1).max(50) }).strict(),
]);
const designs = async ({ service, actor }: { service: Service; actor: Actor }) => authorize(actor, "org.design", {}, await service.kernel.permissions.load()).allowed;

/** Everything in the world an agent can use: objects, the wall calendar, the cleaning robot and trash can. */
export function worldCapabilities(): CapabilityDescriptor[] {
  return [
    {
      id: "objects",
      title: "look at objects",
      description:
        "The world's objects you can use: id, name, room, what each is doing now, its actions, whether you can reach it (your department's rooms, shared rooms, things that walk about), and for the ones with a job how to use them (computers, the cleaning robot, the trash can, the wall calendar).",
      input: z.object({}).strict(),
      permission: null,
      effect: "read",
      approval: "never",
      executor: "kernel",
      execute: async ({ service, actor }) => ({ objects: await service.objectCatalog(actor.kind === "agent" ? (await service.getAgentRow(actor.id)).department_id : undefined) }),
    },
    {
      id: "use_object",
      title: "use an object",
      description:
        "Do one of an object's actions yourself (pull an espresso, pet the shop cat, dim the lamps): you walk over and do it and everyone sees it. Only objects you can reach (see objects); for one in another department's room, ask someone who works there.",
      input: z.object({ objectId: z.string().min(1).max(64), action: z.string().min(1).max(64) }).strict(),
      permission: null,
      effect: "write",
      approval: "never",
      executor: "kernel",
      execute: async ({ service, actor }, a) => service.objectAction(actor, a.objectId, { action: a.action }),
    },
    {
      id: "calendar",
      title: "read the calendar",
      description:
        "The wall calendar: every scheduled job (objects doing their actions, tasks for agents, the cleaning robot's sweeps, the trash can's emptying) and what ran between two days, from and to as YYYY-MM-DD (at most 62 days apart).",
      input: z.object({ from: day, to: day }).strict(),
      permission: null,
      effect: "read",
      approval: "never",
      executor: "kernel",
      execute: async ({ instance, service, actor }, a) => instance.calendar!.view(service, actor, a.from, a.to),
    },
    {
      id: "schedule",
      title: "change the calendar",
      description:
        "Put a job on the wall calendar (op create, with job), change one (op update, id, job) or take it off (op delete, id). A job: {title, who: {type: 'object'|'agent', id}, action (one of the object's action ids) or prompt (the agent's task), repeat: {type: 'weekly', times: [7 entries, Sunday first, each 'HH:MM' or null]} or {type: 'once', date: 'YYYY-MM-DD', at: 'HH:MM'}, timeZone (IANA, e.g. Asia/Ho_Chi_Minh), enabled}. An object's job needs leave to change the world; an agent's needs leave to give that agent tasks (yourself, your reports). Without it this asks the owner, who sets the job up if they agree.",
      input: z.discriminatedUnion("op", [
        z.object({ op: z.literal("create"), job: z.record(z.string(), z.unknown()) }).strict(),
        z.object({ op: z.literal("update"), id: z.string().min(1).max(64), job: z.record(z.string(), z.unknown()) }).strict(),
        z.object({ op: z.literal("delete"), id: z.string().min(1).max(64) }).strict(),
      ]),
      permission: null,
      effect: "write",
      approval: "policy",
      executor: "kernel",
      allowed: ({ instance, service, actor }, a) => instance.calendar!.may(service, actor, a),
      execute: async ({ instance, service, actor }, a) =>
        a.op === "create" ? instance.calendar!.create(service, actor, a.job) : a.op === "update" ? instance.calendar!.update(service, actor, a.id, a.job) : instance.calendar!.remove(service, actor, a.id),
    },
    {
      id: "cleanup",
      title: "use the cleaning robot and trash can",
      description:
        "The cleaning robot and the trash can. op view: their settings, what is in the trash, the last sweeps. op preview: what a sweep now would take. op sweep: sweep now (old leftovers go into the trash, where they can be put back). op empty: delete everything in the trash for good. op restore with itemId: put one item back. Viewing is open to everyone; the rest need leave to change the world, else this asks the owner.",
      input: z.object({ op: z.enum(["view", "preview", "sweep", "empty", "restore"]), itemId: z.string().min(1).max(64).optional() }).strict()
        .refine((a) => a.op !== "restore" || !!a.itemId, { message: "restore needs itemId", path: ["itemId"] }),
      permission: null,
      effect: "write",
      approval: "policy",
      executor: "kernel",
      allowed: async (ctx, a) => a.op === "view" || designs(ctx),
      execute: async ({ instance, service, actor }, a) => {
        const c = instance.cleanup!;
        if (a.op === "view") return c.view(service, actor);
        if (a.op === "preview" || a.op === "sweep") return c.sweepNow(service, actor, a.op === "preview");
        if (a.op === "empty") return c.emptyNow(service, actor);
        return c.restore(service, actor, a.itemId!);
      },
    },
    {
      id: "suggest_config",
      title: "suggest a configuration",
      description:
        "Suggest a different key, model, effort or limits for yourself (or an agent you may configure) where a person chose them; the owner decides, and sets it if they agree. Where nobody chose, configure directly (agentown agent configure).",
      input: z.object({
        agentId: z.string().min(1).max(64),
        credentialId: z.string().min(1).max(64).optional(),
        model: z.string().min(1).max(120).optional(),
        effort: z.enum(EFFORTS).optional(),
        contextLimit: z.number().int().min(8192).max(1_000_000).optional(),
        maxTurns: z.number().int().min(1).max(200).optional(),
        reason: z.string().trim().min(1).max(1000),
      }).strict().refine((a) => ["credentialId", "model", "effort", "contextLimit", "maxTurns"].some((k) => (a as Record<string, unknown>)[k] !== undefined), "suggest at least one setting"),
      permission: "agent.configure",
      effect: "write",
      approval: "always",
      executor: "kernel",
      // Always asked of the owner, but only for an agent the caller may configure.
      allowed: async ({ service, actor }, a) => {
        if (!authorize(actor, "agent.configure", { agentId: a.agentId }, await service.kernel.permissions.load()).allowed) throw deny(`you may not configure ${a.agentId}`);
        return false;
      },
      execute: async ({ service, actor }, { agentId, reason: _, ...change }) => service.configureAgent(actor, agentId, change),
    },
    {
      id: "request_permission",
      title: "ask for a permission",
      description:
        "Ask for a lasting permission you lack (see `agentown whoami` for what you hold), saying what it is for. The owner decides; granted, it is yours from then on. scope (default: org for organization-wide rights such as org.design, else self): self (only you), direct-reports, descendants, team (you and your reports), department, org, or agents / projects / departments by id. For a single thing, rather call its tool: one you lack leave for asks the owner to do it.",
      input: z.object({ action: z.enum(ACTIONS), scope: scopeSchema.optional(), reason: z.string().trim().min(1).max(1000), agentId: z.string().min(1).max(64) }).strict(),
      permission: null,
      effect: "destructive",
      approval: "always",
      executor: "kernel",
      // Always asked: it runs as whoever approves, granting it to the agent who asked.
      allowed: async () => false,
      // Organization-wide rights (changing the world, reading the audit log) only mean something org-wide.
      execute: async ({ service, actor }, a) =>
        service.delegate(actor, { principalId: a.agentId, action: a.action, scope: a.scope ?? { kind: ORG_LEVEL.has(a.action) ? "org" : "self" } }),
    },
  ];
}

/** The registry: the organization tools (the same Service operations the UI uses) plus team and runtime tools. */
export function capabilityRegistry(tools: ChatTool[]): CapabilityDescriptor[] {
  const fromTools = tools.map<CapabilityDescriptor>((t) => ({
    id: t.name,
    title: t.name.replace(/_/g, " "),
    description: t.description,
    input: t.schema,
    permission: TOOL_PERMISSION[t.name] ?? "owner",
    effect: !t.mutates ? "read" : t.important ? "destructive" : "write",
    approval: t.mutates ? "policy" : "never",
    executor: "kernel",
    requiresApproval: (args) => needsApproval(t, args, "important"),
    execute: t.execute,
  }));
  return [
    ...fromTools,
    ...worldCapabilities(),
    {
      id: "propose_patch",
      title: "propose patch",
      description:
        "Propose a change to this install's own source code as a unified diff (get the source with `agentown code checkout DIR`, edit, then `agentown code propose`). The owner reviews and approves every patch; the host then builds, installs and health-checks it, rolling back on failure.",
      input: z.object({ title: z.string().trim().min(1).max(200), summary: z.string().max(4000).default(""), diff: z.string().min(1).max(2_000_000) }).strict(),
      permission: "code.propose",
      effect: "destructive",
      approval: "always",
      executor: "kernel",
      execute: async ({ service, idempotencyKey }, a) => queuePatch(service.orgId, idempotencyKey, a),
    },
    {
      id: "browser",
      title: "use a computer",
      description:
        "Use one of the world's computers (a real Chromium; `agentown browser list` shows them). Each call does one thing and returns the page as text: what it says and what can be clicked or typed into, each with a ref (e5) to use in the next call. upload (path, ref?) hands one of the computer's own files (under /workspace, e.g. a render) to the page's file picker, the ref's or the page's first. A site that needs someone to log in: ask the owner (`agentown browser COMPUTER login \"why\"`), who logs in on the computer's screen; the login stays.",
      input: z.object({
        computer: z.string().min(1).max(40),
        action: z.enum(["look", "open", "click", "type", "key", "scroll", "back", "tab", "upload"]),
        url: z.string().max(2000).optional(),
        ref: z.string().regex(/^e\d+$/).optional(),
        x: z.number().min(0).max(4000).optional(),
        y: z.number().min(0).max(4000).optional(),
        text: z.string().max(10000).optional(),
        submit: z.boolean().optional(),
        key: z.enum(BROWSER_KEYS as [string, ...string[]]).optional(),
        dy: z.number().min(-10000).max(10000).optional(),
        index: z.number().int().min(0).max(50).optional(),
        path: z.string().max(500).optional(),
      }).strict().superRefine((a, ctx) => {
        const need = { open: "url", type: "text", key: "key", tab: "index", upload: "path" }[a.action as string];
        if (need && (a as Record<string, unknown>)[need] === undefined) ctx.addIssue({ code: "custom", message: `${a.action} needs ${need}` });
        if (a.action === "click" && !a.ref && (a.x === undefined || a.y === undefined)) ctx.addIssue({ code: "custom", message: "click needs ref (or x and y)" });
      }),
      permission: null,
      effect: "write",
      approval: "never",
      executor: "kernel",
      execute: async ({ instance, service, actor }, { computer, ...a }) => {
        if (!instance.computers) throw badRequest("this install has no computers");
        // Through the computer's queue: two agents on one computer take turns.
        return { page: (await instance.computers.request(service, computer, actorRef(actor), { app: "browser", ...a })).result };
      },
    },
    {
      id: "computer",
      title: "ask a computer",
      description:
        "Give one of the world's computers work (`agentown browser list` shows them, with their apps). It does its requests one at a time and answers when this one is done. Say it in words ({text}) and the computer works it out with its apps, or ask exactly: {app:'screen', show}, {app:'mcp', action:'tools'|'call', connector, tool, args}, {app:'stream', action:'play'|'stop', url}, {app:'camera', action:'look', question}.",
      input: z.object({ computer: z.string().min(1).max(40), request: computerRequestSchema }).strict(),
      permission: null,
      effect: "write",
      approval: "never",
      executor: "kernel",
      execute: async ({ instance, service, actor }, a) => {
        if (!instance.computers) throw badRequest("this install has no computers");
        return instance.computers.request(service, a.computer, actorRef(actor), a.request);
      },
    },
    {
      id: "connector_tools",
      title: "list outside tools",
      description: "The world's connectors (outside services over MCP), or one connector's tools with their input schemas.",
      input: z.object({ connector: z.string().max(40).optional() }).strict(),
      permission: null,
      effect: "read",
      approval: "never",
      executor: "kernel",
      execute: async ({ service }, a) =>
        a.connector ? { tools: await connectorTools(service, a.connector) } : { connectors: (await listConnectors(service)).map(({ credential, ...c }) => ({ ...c, ready: !!credential })) },
    },
    {
      id: "connector_call",
      title: "call an outside tool",
      description: "Call one tool of a connector. Connectors set to ask wait for approval of every call; auto ones run at once.",
      input: z.object({ connector: z.string().min(1).max(40), tool: z.string().min(1).max(200), arguments: z.record(z.string(), z.unknown()).default({}) }).strict(),
      permission: null,
      effect: "write",
      approval: "policy",
      executor: "kernel",
      requiresApprovalIn: (service, a) => connectorAsks(service, a.connector),
      execute: async ({ service }, a) => callConnector(service, a.connector, a.tool, a.arguments),
    },
    {
      id: "team_say",
      title: "team say",
      description: "Post a message to a team channel (default: your own team).",
      input: z.object({ text: z.string().trim().min(1).max(4000), teamId: z.string().max(60).optional() }).strict(),
      permission: null,
      effect: "write",
      approval: "never",
      executor: "kernel",
      execute: async ({ service, actor }, b) => {
        const teamId = b.teamId ?? (actor.kind === "agent" ? service.teamOf(await service.getAgentRow(actor.id)).id : undefined);
        if (!teamId) throw badRequest("teamId required");
        return postTeamMessage(service, actor, teamId, b.text);
      },
    },
    {
      id: "bash",
      title: "bash",
      description: "Run a shell command in the caller's own runtime (team workspace). Executed by the runtime, not the server.",
      input: z.object({ command: z.string().min(1) }).strict(),
      permission: null,
      effect: "write",
      approval: "never",
      executor: "runtime-local",
    },
  ];
}

export class CapabilityGateway {
  readonly registry: CapabilityDescriptor[];
  constructor(
    private readonly instance: Instance,
    proposals: ProposalEngine,
    tools: ChatTool[],
  ) {
    this.registry = capabilityRegistry(tools);
    // Approving a gateway proposal runs the call as the one who proposed it.
    proposals.register("gateway", { decide: (actor, p, verdict, note) => this.decide(actor, p, verdict, note) });
  }

  private find(id: string) {
    const d = this.registry.find((c) => c.id === id);
    if (!d) throw notFound("capability");
    return d;
  }

  /** Does the caller hold this permission somewhere in the organization? */
  private async permits(service: Service, actor: Actor) {
    const { permissions, rules } = service.kernel;
    const policy = await permissions.load();
    const where = { agentIds: [...policy.graph.agents.values()].filter((a) => a.lifecycleState !== "retired").map((a) => a.id), templateIds: rules.config.agentTemplates.map((t) => t.id) };
    return (perm: CapabilityDescriptor["permission"]) => {
      if (perm === null) return true;
      if (actor.kind === "human" && actor.owner) return true;
      if (perm === "owner") return false;
      return permissions.allowedAnywhere(actor, perm, policy, where);
    };
  }

  /** For a world tool: who must approve, and as whom the change runs once approved. */
  private worldGate(service: Service, actor: Actor, permitted: boolean): { approval: "never" | "always"; runAs: "proposer" | "approver" } {
    if (actor.kind === "human" && actor.owner) return { approval: "never", runAs: "proposer" };
    if (!permitted) return { approval: "always", runAs: "approver" };
    return { approval: service.config.kernel.worldEdits === "auto" ? "never" : "always", runAs: "proposer" };
  }

  /** Discovery: what this caller may use, with input schemas. */
  async discover(service: Service, actor: Actor) {
    const has = await this.permits(service, actor);
    return this.registry
      .filter((d) => has(d.permission) || WORLD_TOOLS.has(d.id))
      .map((d) => ({
        id: d.id, title: d.title, description: d.description, effect: d.effect,
        approval: WORLD_TOOLS.has(d.id) ? this.worldGate(service, actor, has(d.permission)).approval : d.approval,
        executor: d.executor,
        permission: d.permission, input: z.toJSONSchema(d.input, { target: "draft-7", unrepresentable: "any" }),
      }));
  }

  /** The one door: validate, authorize, maybe propose, execute, audit. */
  async invoke(service: Service, actor: Actor, id: string, rawArgs: unknown, idempotencyKey?: string, context: { taskId?: string | null } = {}) {
    const d = this.find(id);
    if (d.executor !== "kernel" || !d.execute) throw badRequest(`${id} runs inside the caller's runtime, not through the server`);
    if (id === "request_permission") {
      // An agent asks for itself; people ask the owner in person.
      if (actor.kind !== "agent") throw badRequest("people ask the owner for permissions directly");
      rawArgs = { ...(rawArgs as Record<string, unknown>), agentId: actor.id };
    }
    const parsed = d.input.safeParse(rawArgs ?? {});
    if (!parsed.success) throw badRequest(z.prettifyError(parsed.error));
    if (!(await this.discover(service, actor)).some((c) => c.id === id)) {
      await service.kernel.permissions.audit(service.db, actor, "capability.invoke", id, false, "capability not available to caller");
      throw deny(`${id} is not available to you`);
    }
    const owner = actor.kind === "human" && actor.owner;
    const world = WORLD_TOOLS.has(id) ? this.worldGate(service, actor, (await this.permits(service, actor))(d.permission)) : null;
    // A call the caller may not make itself becomes a request: whoever approves carries it out.
    const short = !world && !owner && !!d.allowed && !(await d.allowed({ instance: this.instance, service, actor }, parsed.data));
    const asApprover = world?.runAs === "approver" || short;
    const needs = world
      ? world.approval === "always"
      : short || d.approval === "always" || (d.approval === "policy" && !!(d.requiresApprovalIn ? d.requiresApprovalIn(service, parsed.data) : d.requiresApproval?.(parsed.data)));
    // With the kernel setting approver "lead", the agent at the top decides instead of the owner (code changes stay the owner's).
    const lead = needs && !owner && id !== "propose_patch" && id !== "request_permission" && id !== "suggest_config" && service.config.kernel.approver === "lead" ? await service.leadAgentId() : null;
    if (lead && actor.kind === "agent" && actor.id === lead) {
      // Its own requests go through at once, on the owner's authority where its own permission falls short.
      const runner = asApprover ? await service.ownerActor() : actor;
      const result = await this.run(service, runner, d, parsed.data, idempotencyKey);
      await service.kernel.permissions.audit(service.db, actor, "capability.self_approved", id, true, "approver: lead (kernel setting)");
      return { status: "applied" as const, result };
    }
    if (needs && !owner && (id === "patch_world" || id === "replace_world")) {
      // A world that would not save is sent back now, for the agent to fix, not put in front of the approver.
      const a = parsed.data as { world?: Record<string, unknown> | null; operations?: Parameters<typeof patchDocument>[1] };
      const world = id === "replace_world" ? a.world ?? null : ((await service.db.query("SELECT config->'world' AS w FROM organizations WHERE id=$1", [service.orgId])).rows[0].w ?? null);
      if (id === "patch_world" && !world) throw badRequest("world has no custom layout; use replace_world to create one");
      await this.instance.checkOrgWorld(service, id === "patch_world" ? (patchDocument(world, a.operations!) as Record<string, unknown>) : world);
    }
    if (needs && !owner && id === "task_action" && actor.kind === "agent") {
      // Reviewing your own work can never be approved: say so now instead of queuing it for the owner.
      const a = parsed.data as { id: string; action: string };
      const mine = await service.db.query("SELECT 1 FROM tasks WHERE id=$1 AND org_id=$2 AND assignee_agent_id=$3", [a.id, service.orgId, actor.id]);
      if (["approve", "reject"].includes(a.action) && mine.rows[0]) throw deny("cannot review your own work; to finish your task, end your reply with a summary");
    }
    if (needs && !owner) {
      // The same request asked again (an agent retrying) waits on the first one.
      const same = await service.db.query<{ id: string }>(
        `SELECT id FROM proposals WHERE org_id=$1 AND status='pending' AND source_type='gateway' AND proposer=$2
            AND payload->>'capability'=$3 AND (payload->'args') - 'revision' = ($4::jsonb) - 'revision' LIMIT 1`,
        [service.orgId, actorRef(actor), id, JSON.stringify(parsed.data)],
      );
      if (same.rows[0]) return { status: "pending" as const, proposalId: same.rows[0].id };
      // One world edit waits per agent: a newer one replaces what it proposed before (it is meant to hold every change).
      if (world) {
        const older = await service.db.query<{ source_type: string; source_id: string }>(
          "SELECT source_type, source_id FROM proposals WHERE org_id=$1 AND status='pending' AND kind='world_change' AND proposer=$2",
          [service.orgId, actorRef(actor)],
        );
        for (const o of older.rows) await recordProposal(service.db, { type: o.source_type, id: o.source_id }, { status: "withdrawn", decision: { by: actorRef(actor), verdict: "reject", note: "replaced by a newer world edit" } });
      }
      const rule = world ? (world.runAs === "approver" ? "world:no_permission" : "world:approve") : id === "request_permission" ? "permission:request" : short ? "permission:missing" : d.approval === "always" ? "always" : `effect:${d.effect}`;
      const reason = world
        ? world.runAs === "approver" ? "the caller may not design the world; the owner applies the change if they approve it" : "world edits wait for the owner (kernel setting worldEdits: approve)"
        : id === "request_permission" ? `asks for ${(parsed.data as { action: string }).action}: ${(parsed.data as { reason: string }).reason}`
        : short ? "the caller lacks the permission for this; whoever approves it carries it out" : "this call changes the organization and needs the owner's approval";
      const p = await openProposal(service.db, {
        orgId: service.orgId, kind: world ? "world_change" : "capability_call", title: `${d.title}`, proposer: actorRef(actor),
        subject: actor.kind === "agent" ? { type: "agent", id: actor.id } : null,
        payload: {
          capability: id, args: parsed.data, idempotencyKey: idempotencyKey ?? null,
          ...(asApprover ? { runAs: "approver" } : {}),
          // The task it came from waits for the decision (and is told the outcome).
          ...(context.taskId ? { taskId: context.taskId } : {}),
        },
        source: { type: "gateway", id: newId("cg") }, approvers: lead ? { kind: "lead", agentId: lead } : { kind: "owner" }, exact: true,
        evaluation: [{ rule, verdict: "require_approval", reason: lead ? `${reason.replace("the owner's", "the lead's").replace("the owner", "the lead")} (kernel setting approver: lead)` : reason }],
      });
      if (lead) await service.requestLeadReview(lead, p.id, actor, d.title, parsed.data, context.taskId ?? null);
      await service.kernel.permissions.audit(service.db, actor, "capability.propose", id, true, "awaiting approval", { proposalId: p.id });
      return { status: "pending" as const, proposalId: p.id };
    }
    const result = await this.run(service, actor, d, parsed.data, idempotencyKey);
    return { status: "applied" as const, result };
  }

  private async run(service: Service, actor: Actor, d: CapabilityDescriptor, args: unknown, idempotencyKey?: string) {
    try {
      const result = await d.execute!({ instance: this.instance, service, actor, idempotencyKey: idempotencyKey ?? `gw-${newId("k")}` }, args);
      await service.kernel.permissions.audit(service.db, actor, "capability.invoke", d.id, true, d.effect);
      return result ?? { ok: true };
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 403)) await service.kernel.permissions.audit(service.db, actor, "capability.invoke", d.id, false, String((err as Error).message).slice(0, 200));
      throw err;
    }
  }

  private async decide(actor: Actor, p: ProposalRow, verdict: "approve" | "reject", note: string) {
    const lead = p.approvers.kind === "lead" && actor.kind === "agent" && actor.id === p.approvers.agentId;
    if (!(actor.kind === "human" && actor.owner) && !lead) throw deny("only the owner (or, if the owner chose so, the lead agent) approves these calls");
    const service = await this.instance.org(p.org_id);
    const source = { type: p.source_type, id: p.source_id };
    const decision = { by: actorRef(actor), verdict, ...(note ? { note } : {}) };
    const tell = async (outcome: string, result?: unknown) => {
      // A call made for its answer (an outside tool) hands the answer back too.
      const text = (result as { text?: unknown } | undefined)?.text;
      const answer = typeof text === "string" ? `\nResult:\n${text.slice(0, 4000)}` : "";
      if (p.payload.taskId) await service.resumeFromOwner(String(p.payload.taskId), `Your request "${p.title}" (${String(p.payload.capability)}) was ${outcome}${note ? `: ${note}` : "."}${answer}`);
    };
    // A caller without the permission proposed it: the approving owner carries it out.
    // The lead approves on the owner's authority: a change the proposer may not make itself runs as the owner.
    const runner = p.payload.runAs === "approver" ? (lead ? await service.ownerActor() : actor) : await service.kernel.identity.parseActorRef(p.proposer);
    const d = this.find(String(p.payload.capability));
    // Copies of the same request (from before duplicates were folded) share its fate.
    const closeCopies = async (outcome: string) => {
      const copies = await service.db.query<{ source_type: string; source_id: string }>(
        `SELECT source_type, source_id FROM proposals WHERE org_id=$1 AND status='pending' AND id<>$2 AND source_type='gateway' AND proposer=$3
            AND payload->>'capability'=$4 AND (payload->'args') - 'revision' = ($5::jsonb) - 'revision'`,
        [service.orgId, p.id, p.proposer, d.id, JSON.stringify(p.payload.args)],
      );
      for (const c of copies.rows) await recordProposal(service.db, { type: c.source_type, id: c.source_id }, { status: "rejected", decision: { by: actorRef(actor), verdict: "reject", note: `same as ${p.id}, which ${outcome}` } });
    };
    if (verdict === "reject") {
      await recordProposal(service.db, source, { status: "rejected", decision });
      await closeCopies("was rejected");
      return tell("rejected");
    }
    await recordProposal(service.db, source, { status: "applying", decision });
    const args = d.input.parse(p.payload.args);
    try {
      const result = await this.run(service, runner, d, args, (p.payload.idempotencyKey as string | null) ?? `proposal-${p.id}`);
      await recordProposal(service.db, source, { status: "applied", receipt: result });
      await closeCopies("was applied");
      await tell("approved and done", result);
      return result;
    } catch (err) {
      await recordProposal(service.db, source, { status: "failed", error: String((err as Error).message).slice(0, 2000) });
      await closeCopies("failed");
      await tell(`approved but failed (${String((err as Error).message).slice(0, 300)})`);
      throw err;
    }
  }
}
