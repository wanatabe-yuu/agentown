import type { Action, Actor } from "@agentown/core";
import { z } from "zod";
import { needsApproval } from "./chat/tools.ts";
import type { ChatTool, ToolContext } from "./chat/types.ts";
import { postTeamMessage } from "./conversations.ts";
import type { Instance } from "./instance.ts";
import { openProposal, type ProposalEngine, type ProposalRow, recordProposal } from "./proposals.ts";
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
};

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

  /** Discovery: what this caller may use, with input schemas. */
  async discover(service: Service, actor: Actor) {
    const { permissions, rules } = service.kernel;
    const policy = await permissions.load();
    const where = { agentIds: [...policy.graph.agents.values()].filter((a) => a.lifecycleState !== "retired").map((a) => a.id), templateIds: rules.config.agentTemplates.map((t) => t.id) };
    const has = (perm: CapabilityDescriptor["permission"]) => {
      if (perm === null) return true;
      if (actor.kind === "human" && actor.owner) return true;
      if (perm === "owner") return false;
      return permissions.allowedAnywhere(actor, perm, policy, where);
    };
    return this.registry
      .filter((d) => has(d.permission))
      .map((d) => ({
        id: d.id, title: d.title, description: d.description, effect: d.effect, approval: d.approval, executor: d.executor,
        permission: d.permission, input: z.toJSONSchema(d.input, { target: "draft-7", unrepresentable: "any" }),
      }));
  }

  /** The one door: validate, authorize, maybe propose, execute, audit. */
  async invoke(service: Service, actor: Actor, id: string, rawArgs: unknown, idempotencyKey?: string) {
    const d = this.find(id);
    if (d.executor !== "kernel" || !d.execute) throw badRequest(`${id} runs inside the caller's runtime, not through the server`);
    const parsed = d.input.safeParse(rawArgs ?? {});
    if (!parsed.success) throw badRequest(z.prettifyError(parsed.error));
    if (!(await this.discover(service, actor)).some((c) => c.id === id)) {
      await service.kernel.permissions.audit(service.db, actor, "capability.invoke", id, false, "capability not available to caller");
      throw deny(`${id} is not available to you`);
    }
    const owner = actor.kind === "human" && actor.owner;
    const needs = d.approval === "always" || (d.approval === "policy" && !!d.requiresApproval?.(parsed.data));
    if (needs && !owner) {
      const p = await openProposal(service.db, {
        orgId: service.orgId, kind: "capability_call", title: `${d.title}`, proposer: actorRef(actor),
        subject: actor.kind === "agent" ? { type: "agent", id: actor.id } : null,
        payload: { capability: id, args: parsed.data, idempotencyKey: idempotencyKey ?? null },
        source: { type: "gateway", id: newId("cg") }, approvers: { kind: "owner" },
        evaluation: [{ rule: d.approval === "always" ? "always" : `effect:${d.effect}`, verdict: "require_approval", reason: "this call changes the organization and needs the owner's approval" }],
      });
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
    if (!(actor.kind === "human" && actor.owner)) throw deny("only the owner approves these calls");
    const service = await this.instance.org(p.org_id);
    const source = { type: p.source_type, id: p.source_id };
    const decision = { by: actorRef(actor), verdict, ...(note ? { note } : {}) };
    if (verdict === "reject") return recordProposal(service.db, source, { status: "rejected", decision });
    await recordProposal(service.db, source, { status: "applying", decision });
    const proposer = await service.kernel.identity.parseActorRef(p.proposer);
    const d = this.find(String(p.payload.capability));
    try {
      const result = await this.run(service, proposer, d, d.input.parse(p.payload.args), (p.payload.idempotencyKey as string | null) ?? `proposal-${p.id}`);
      await recordProposal(service.db, source, { status: "applied", receipt: result });
      return result;
    } catch (err) {
      await recordProposal(service.db, source, { status: "failed", error: String((err as Error).message).slice(0, 2000) });
      throw err;
    }
  }
}
