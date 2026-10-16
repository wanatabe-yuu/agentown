import { z } from "zod";
import { worldSchema } from "@agentown/core";
import type { ChatTool } from "./types.ts";
import { badRequest } from "../util.ts";

const id = z.string().min(1).max(100);
const patchSchema = z.object({ revision: z.number().int(), operations: z.array(z.object({
  op: z.enum(["add", "replace", "remove"]), path: z.string().min(1).max(500), value: z.unknown().optional(),
}).strict()).min(1).max(80) }).strict();

function readPath(doc: any, path: string) {
  if (!path.startsWith("/")) throw badRequest("paths must start with /");
  for (const key of path.slice(1).split("/").map(s => s.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (["__proto__", "constructor", "prototype"].includes(key) || !doc || typeof doc !== "object" || !Object.hasOwn(doc, key)) throw badRequest("path does not exist");
    doc = doc[key];
  }
  return doc;
}

/** A deliberately small JSON Patch implementation: no prototype access, no implicit creation. */
export function patchDocument(doc: unknown, operations: z.infer<typeof patchSchema>["operations"]) {
  const next = structuredClone(doc);
  for (const p of operations) {
    if (!p.path.startsWith("/")) throw badRequest("patch paths must start with /");
    const parts = p.path.slice(1).split("/").map(s => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (parts.some(s => ["__proto__", "prototype", "constructor"].includes(s))) throw badRequest("invalid patch path");
    let parent: any = next;
    for (const key of parts.slice(0, -1)) {
      if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, key)) throw badRequest("patch parent does not exist");
      parent = parent[key];
    }
    if (!parent || typeof parent !== "object") throw badRequest("patch parent must be an object or array");
    const key = parts.at(-1)!;
    const exists = Object.hasOwn(parent, key);
    if (p.op !== "add" && !exists) throw badRequest("patch target does not exist");
    if (p.op !== "remove" && !Object.hasOwn(p, "value")) throw badRequest("patch value is required");
    if (Array.isArray(parent)) {
      const n = key === "-" && p.op === "add" ? parent.length : Number(key);
      if (!/^(0|[1-9]\d*|-)$/.test(key) || !Number.isInteger(n) || n < 0 || n > parent.length || (n === parent.length && p.op !== "add")) throw badRequest("invalid array index");
      if (p.op === "remove") parent.splice(n, 1);
      else if (p.op === "add") parent.splice(n, 0, p.value);
      else parent[n] = p.value;
    } else if (p.op === "remove") delete parent[key];
    else parent[key] = p.value;
  }
  return next as Record<string, unknown>;
}

/** Same validated Service operations as the UI; no HTTP proxy, shell, secrets or cross-org tools. */
export function ownerTools(s: Record<string, z.ZodType>): ChatTool[] {
  const payload = (name: string) => z.object({ id, change: s[name]! }).strict();
  return [
    { name: "inspect", description: "Read current world or organization data. Snapshot includes agents and tasks. Config contains departments, projects, roles and job templates. Read before editing; use exact IDs and revision. Agent/task need id. No secrets are returned.",
      schema: z.object({ kind: z.enum(["snapshot", "capabilities", "world", "world_schema", "config", "catalog", "credentials", "users", "assets", "audit", "agent", "task", "logs"]), id: id.optional(), path: z.string().max(500).optional() }).strict(),
      execute: async ({ service: v, actor: a }, b) => {
        switch (b.kind) {
          case "snapshot": return v.snapshot(a);
          case "capabilities": return v.chatTaskCapabilities(a);
          case "world": { const data = await v.getWorld(a); return b.path ? { revision: data.revision, path: b.path, value: readPath(data.world, b.path) } : data; }
          case "world_schema": return { schema: z.toJSONSchema(worldSchema, { target: "draft-7" }), example: { floors: [{ id: "ground", name: "Ground floor", rooms: [{ id: "lobby", name: "Lobby", area: { x: 0, z: 0, w: 10, d: 8 } }] }] }, note: "Read this before creating a new layout. Room department IDs must match the current organization; asset IDs must belong to this world." };
          case "config": { const data = await v.getConfig(a); return b.path ? { revision: data.revision, path: b.path, value: readPath(data.doc, b.path) } : data; }
          case "catalog": return v.catalog(a);
          case "credentials": return v.listCredentials(a); case "users": return v.listUsers(a);
          case "assets": return v.listAssets(a); case "audit": return (await v.listAudit(a, 0)).slice(0, 80);
          case "agent": if (!b.id) throw badRequest("id required"); return v.getAgent(a, b.id);
          case "task": if (!b.id) throw badRequest("id required"); return v.getTask(a, b.id);
          case "logs": if (!b.id) throw badRequest("id required"); return (await v.logs(a, b.id, 0)).slice(-80);
        }
      } },
    { name: "patch_world", description: "Edit the world with JSON Patch add/replace/remove operations (rooms, floors, furniture, placements, lights, art). No revision is needed: the operations apply to the world as it is when they run, also after waiting for approval. Put every change into one call; a new call replaces your earlier one that still waits for approval. The server checks the whole result at once and tells you what is wrong. Removing items requires owner confirmation; an agent's edits may wait for the owner's approval (kernel setting).",
      schema: patchSchema.extend({ revision: z.number().int().optional() }), mutates: true,
      execute: async ({ instance, service, actor }, b) => {
        const { rows } = await service.db.query("SELECT config->'world' AS world, config_revision FROM organizations WHERE id=$1", [service.orgId]);
        if (!rows[0].world) throw badRequest("world has no custom layout; use replace_world to create one");
        return instance.updateOrgWorld(service, actor, { revision: rows[0].config_revision, world: patchDocument(rows[0].world, b.operations) });
      } },
    { name: "replace_world", description: "Create or replace the complete custom world (null resets to default). Read world/config and use their revision. Requires owner confirmation unless the owner lets designers apply directly.",
      schema: s.orgWorld!, mutates: true, important: true,
      execute: ({ instance, service, actor }, b) => instance.updateOrgWorld(service, actor, b) },
    { name: "patch_config", description: "Edit departments, projects, roles, permission profiles or job templates using JSON Patch and current config revision. Existing grants are copies; do not imply they automatically change. Requires owner confirmation.",
      schema: patchSchema, mutates: true, important: true,
      execute: async ({ instance, service, actor }, b) => instance.updateOrgConfig(service, actor, { revision: b.revision, doc: patchDocument((await service.getConfig(actor)).doc, b.operations) }) },
    { name: "create_task", description: "Create a prompt task in this organization, as in New task. Specify an assignee/project if requested; the agent must have a model/key. No API-key config is changed implicitly. Use description for the task's prompt.",
      schema: z.object({ title: z.string().min(1).max(200), description: z.string().max(20000).optional(), acceptanceCriteria: z.string().max(5000).optional(),
        assigneeAgentId: id.nullable().optional(), projectId: id.nullable().optional(), parentTaskId: id.nullable().optional(), inputTaskIds: z.array(id).max(20).optional(), requiresReview: z.boolean().optional() }).strict(), mutates: true,
      execute: ({ service, actor, idempotencyKey }, b) => service.createTask(actor, { ...b, spec: { kind: "prompt" }, idempotencyKey }) },
    { name: "task_action", description: "Assign, retry, cancel or review an existing task. Cancel and review require confirmation.",
      schema: z.object({ id, action: z.enum(["assign", "retry", "cancel", "approve", "reject"]), assigneeAgentId: id.optional(), note: z.string().max(2000).default("") }).strict(), mutates: true,
      execute: ({ service: v, actor: a }, b) => {
        if (b.action === "assign") { if (!b.assigneeAgentId) throw badRequest("assigneeAgentId required"); return v.assignTask(a, b.id, b.assigneeAgentId); }
        if (b.action === "retry") return v.retryTask(a, b.id);
        if (b.action === "cancel") return v.cancelTask(a, b.id, b.note);
        return v.reviewTask(a, b.id, b.action, b.note);
      } },
    { name: "spawn_agent", description: "Hire an agent using an approved job template and parent. No credentials or model are assigned unless explicitly specified.",
      schema: s.spawn!, mutates: true, important: true,
      execute: ({ service, actor, idempotencyKey }, b) => service.spawn(actor, { ...b, idempotencyKey }) },
    { name: "update_agent", description: "Rename an agent or change its reporting line. Reporting changes require confirmation.", schema: payload("updateAgent"), mutates: true,
      execute: ({ service, actor }, b) => service.updateAgent(actor, b.id, b.change) },
    { name: "configure_agent", description: "Change API credential assignment, model, effort, instructions or maxTurns for an agent. Credentials are IDs from inspect credentials, never raw keys. Requires confirmation.", schema: payload("agentConfig"), mutates: true, important: true,
      execute: ({ service, actor }, b) => { const { expectedRevision, ...change } = b.change; return service.configureAgent(actor, b.id, change, { expectedRevision }); } },
    { name: "agent_action", description: "Pause/resume intake or start/stop/restart the isolated agent runtime. Stop/restart require confirmation.",
      schema: z.object({ id, action: z.enum(["pause", "resume", "start", "stop", "restart"]) }).strict(), mutates: true,
      execute: ({ service, actor }, b) => ["pause", "resume"].includes(b.action) ? service.setIntake(actor, b.id, b.action === "resume") : service.setRuntime(actor, b.id, b.action) },
    { name: "retire_agent", description: "Retire an agent, optionally purging its workspace. Requires confirmation; service enforces hierarchy and active-work constraints.",
      schema: z.object({ id, purgeWorkspace: z.boolean().default(false) }).strict(), mutates: true, important: true,
      execute: ({ service, actor }, b) => service.retire(actor, b.id, b.purgeWorkspace) },
    { name: "update_person", description: "Change a member's display name, role or disabled state inside this organization. Requires confirmation. Cannot change shared account names from here.",
      schema: payload("updateUser"), mutates: true, important: true,
      execute: ({ service, actor }, b) => service.updateUser(actor, b.id, b.change) },
    { name: "grant_person", description: "Grant a permission to an existing organization member. Requires confirmation.", schema: payload("grantUser"), mutates: true, important: true,
      execute: ({ service, actor }, b) => service.grantUser(actor, b.id, b.change) },
    { name: "revoke_permission", description: "Revoke an agent or person grant within this organization. Requires confirmation.",
      schema: z.object({ id, userId: id.optional() }).strict(), mutates: true, important: true,
      execute: ({ service, actor }, b) => b.userId ? service.revokeUserGrant(actor, b.userId, b.id) : service.revokeGrant(actor, b.id) },
    { name: "delegate_permission", description: "Grant an agent permission inside this organization. Requires confirmation.", schema: s.delegate!, mutates: true, important: true,
      execute: ({ service, actor }, b) => service.delegate(actor, b) },
    { name: "credential_action", description: "Refresh model metadata or revoke an existing credential. Never creates or reveals raw keys. Revocation requires confirmation.",
      schema: z.object({ id, action: z.enum(["refresh", "revoke"]) }).strict(), mutates: true,
      execute: ({ service, actor }, b) => b.action === "refresh" ? service.refreshCredentialModels(actor, b.id) : service.revokeCredential(actor, b.id) },
    { name: "upload_asset", description: "Add art to the organization's library: a texture/image (PNG, JPEG, WebP) or a 3D model (GLB), base64-encoded, up to 20 MB. Returns its id; place it in the world with patch_world (a kind's look { asset: id }, a room's floorTexture/wallTexture, or an object's image).",
      schema: z.object({ kind: z.enum(["texture", "model"]), name: z.string().trim().min(1).max(80), contentBase64: z.string().min(1).max(28_000_000) }).strict(), mutates: true,
      execute: ({ service, actor }, b) => service.uploadAsset(actor, { kind: b.kind, name: b.name, content: Buffer.from(b.contentBase64, "base64") }) },
    { name: "delete_asset", description: "Delete art in the current organization; assets still used by the world cannot be deleted. Requires confirmation.", schema: z.object({ id }).strict(), mutates: true, important: true,
      execute: ({ service, actor }, b) => service.deleteAsset(actor, b.id) },
  ];
}

export function needsApproval(tool: ChatTool, args: any, mode: "important" | "all") {
  return !!tool.mutates && (mode === "all" || tool.important ||
    (tool.name === "patch_world" && args.operations.some((p: any) => p.op === "remove")) ||
    (tool.name === "task_action" && ["cancel", "approve", "reject"].includes(args.action)) ||
    (tool.name === "agent_action" && ["stop", "restart"].includes(args.action)) ||
    (tool.name === "update_agent" && Object.hasOwn(args.change, "reportsToAgentId")) ||
    (tool.name === "credential_action" && args.action === "revoke"));
}
