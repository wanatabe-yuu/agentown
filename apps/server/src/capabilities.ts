import type { Action, Actor } from "@agentown/core";
import { z } from "zod";
import { needsApproval } from "./chat/tools.ts";
import type { ChatTool, ToolContext } from "./chat/types.ts";
import { postTeamMessage } from "./conversations.ts";
import type { Instance } from "./instance.ts";
import { openProposal, type ProposalEngine, type ProposalRow, recordProposal } from "./proposals.ts";
import { BROWSER_KEYS } from "./computers.ts";
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
        "Use one of the world's computers (a real Chromium; `agentown browser list` shows them). Each call does one thing and returns the page as text: what it says and what can be clicked or typed into, each with a ref (e5) to use in the next call. A site that needs someone to log in: ask the owner (`agentown browser COMPUTER login \"why\"`), who logs in on the computer's screen; the login stays.",
      input: z.object({
        computer: z.string().min(1).max(40),
        action: z.enum(["look", "open", "click", "type", "key", "scroll", "back", "tab"]),
        url: z.string().max(2000).optional(),
        ref: z.string().regex(/^e\d+$/).optional(),
        x: z.number().min(0).max(4000).optional(),
        y: z.number().min(0).max(4000).optional(),
        text: z.string().max(10000).optional(),
        submit: z.boolean().optional(),
        key: z.enum(BROWSER_KEYS as [string, ...string[]]).optional(),
        dy: z.number().min(-10000).max(10000).optional(),
        index: z.number().int().min(0).max(50).optional(),
      }).strict().superRefine((a, ctx) => {
        const need = { open: "url", type: "text", key: "key", tab: "index" }[a.action as string];
        if (need && (a as Record<string, unknown>)[need] === undefined) ctx.addIssue({ code: "custom", message: `${a.action} needs ${need}` });
        if (a.action === "click" && !a.ref && (a.x === undefined || a.y === undefined)) ctx.addIssue({ code: "custom", message: "click needs ref (or x and y)" });
      }),
      permission: null,
      effect: "write",
      approval: "never",
      executor: "kernel",
      execute: async ({ instance, service }, { computer, ...a }) => {
        if (!instance.computers) throw badRequest("this install has no computers");
        return { page: await instance.computers.act(service, computer, a) };
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
    const parsed = d.input.safeParse(rawArgs ?? {});
    if (!parsed.success) throw badRequest(z.prettifyError(parsed.error));
    if (!(await this.discover(service, actor)).some((c) => c.id === id)) {
      await service.kernel.permissions.audit(service.db, actor, "capability.invoke", id, false, "capability not available to caller");
      throw deny(`${id} is not available to you`);
    }
    const owner = actor.kind === "human" && actor.owner;
    const world = WORLD_TOOLS.has(id) ? this.worldGate(service, actor, (await this.permits(service, actor))(d.permission)) : null;
    const needs = world
      ? world.approval === "always"
      : d.approval === "always" || (d.approval === "policy" && !!(d.requiresApprovalIn ? d.requiresApprovalIn(service, parsed.data) : d.requiresApproval?.(parsed.data)));
    // With the kernel setting approver "lead", the agent at the top decides instead of the owner (code changes stay the owner's).
    const lead = needs && !owner && id !== "propose_patch" && service.config.kernel.approver === "lead" ? await service.leadAgentId() : null;
    if (lead && actor.kind === "agent" && actor.id === lead) {
      // Its own requests go through at once, on the owner's authority where its own permission falls short.
      const runner = world?.runAs === "approver" ? await service.ownerActor() : actor;
      const result = await this.run(service, runner, d, parsed.data, idempotencyKey);
      await service.kernel.permissions.audit(service.db, actor, "capability.self_approved", id, true, "approver: lead (kernel setting)");
      return { status: "applied" as const, result };
    }
    if (needs && !owner) {
      const rule = world ? (world.runAs === "approver" ? "world:no_permission" : "world:approve") : d.approval === "always" ? "always" : `effect:${d.effect}`;
      const reason = world
        ? world.runAs === "approver" ? "the caller may not design the world; the owner applies the change if they approve it" : "world edits wait for the owner (kernel setting worldEdits: approve)"
        : "this call changes the organization and needs the owner's approval";
      const p = await openProposal(service.db, {
        orgId: service.orgId, kind: world ? "world_change" : "capability_call", title: `${d.title}`, proposer: actorRef(actor),
        subject: actor.kind === "agent" ? { type: "agent", id: actor.id } : null,
        payload: {
          capability: id, args: parsed.data, idempotencyKey: idempotencyKey ?? null,
          ...(world?.runAs === "approver" ? { runAs: "approver" } : {}),
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
    if (verdict === "reject") {
      await recordProposal(service.db, source, { status: "rejected", decision });
      return tell("rejected");
    }
    await recordProposal(service.db, source, { status: "applying", decision });
    // A caller without the permission proposed it: the approving owner carries it out.
    // The lead approves on the owner's authority: a change the proposer may not make itself runs as the owner.
    const runner = p.payload.runAs === "approver" ? (lead ? await service.ownerActor() : actor) : await service.kernel.identity.parseActorRef(p.proposer);
    const d = this.find(String(p.payload.capability));
    try {
      const result = await this.run(service, runner, d, d.input.parse(p.payload.args), (p.payload.idempotencyKey as string | null) ?? `proposal-${p.id}`);
      await recordProposal(service.db, source, { status: "applied", receipt: result });
      await tell("approved and done", result);
      return result;
    } catch (err) {
      await recordProposal(service.db, source, { status: "failed", error: String((err as Error).message).slice(0, 2000) });
      await tell(`approved but failed (${String((err as Error).message).slice(0, 300)})`);
      throw err;
    }
  }
}
