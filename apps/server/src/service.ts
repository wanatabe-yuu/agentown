import { worldIdentities } from "./world-identities.ts";
import {
  type Action,
  type Actor,
  type AgentConfig,
  type Effort,
  type Grant,
  type GrantConstraints,
  type OrgConfig,
  type PolicyContext,
  type Scope,
  type TaskSpec,
  type TaskStatus,
  type WorkState,
  type ApiProtocol,
  type AuthHeader,
  apiProtocol,
  defaultAuthHeader,
  authHeaderSchema,
  worldAssets,
  canTalk,
  isComputerKind,
  objectState,
  type World,
  PLAYBOOK_ARG_NAME,
  PLAYBOOK_NAME,
  EFFORTS,
  WORK_STATES,
  authorize,
  isGrantEffective,
  canDelegate,
  canGrantToUser,
  principalOf,
  ORG_ACTIONS,
  USER_SCOPE_KINDS,
  canTransition,
  isTerminal,
  cpuMillis,
  memoryMib,
  teamsOf,
  type RuntimePreset,
  type TeamConfig,
} from "@agentown/core";
import type pg from "pg";
import { z } from "zod";
import { AssetRejected, type AssetKind, ORG_QUOTA, sniffAsset } from "./assets.ts";
import type { AgentEventRow, EventBus } from "./bus.ts";
import { type Db, type Queryable, tx } from "./db.ts";
import { type ModelLister, normalizeBaseUrl, PROVIDER_INFO, PROVIDERS, type Provider, providerBaseUrl, providerInfo, WORKSPACE_ID_PATTERN } from "./providers.ts";
import { openProposal, recordProposal } from "./proposals.ts";
import { type CredentialRow, type GrantRow, Kernel, type LoadedPolicy, MEMBERS_SQL, type ModelConnection, parseShare, type Share } from "./kernel/index.ts";
import type { Permissions } from "./kernel/permissions.ts";

export type { LoadedPolicy, Share };
import type { SecretBox } from "./secrets.ts";
import { type Language, languageInstruction, translateNames } from "./locales.ts";
import {
  ApiError,
  actorRef,
  badRequest,
  conflict,
  deny,
  newId,
  newSecret,
  notFound,
  redactLine,
  sanitize,
  sha256,
} from "./util.ts";

const LEASE_SECONDS = 60;
const HEARTBEAT_STALE_MS = 45_000;
const TICKET_TTL_MS = 30_000;

export interface AgentRow {
  id: string;
  org_id: string;
  department_id: string;
  display_name: string;
  job_role: string;
  template_id: string;
  reports_to: string | null;
  lifecycle_state: "provisioning" | "active" | "retired";
  desired_runtime: "running" | "stopped";
  accepting_work: boolean;
  created_by: string;
  seat: number;
  work_state: WorkState;
  work_detail: string | null;
  work_updated_at: Date | null;
  last_heartbeat_at: Date | null;
  created_at: Date;
  credential_id: string | null;
  config_set_by: string | null;
  model: string | null;
  effort: Effort | null;
  instructions: string;
  max_turns: number;
  context_limit: number | null;
  config_revision: number;
  /** null = the department's default team. */
  team_id: string | null;
  /** Declared share of the team runtime; null = the preset's member default. */
  cpu_millis: number | null;
  memory_mib: number | null;
}

/** Resource share in millicores / MiB. */

/** The one runtime a team shares. */
export interface TeamRuntimeRow {
  org_id: string;
  team_id: string;
  runtime_id: string;
  preset_id: string;
  generation: number;
  namespace: string;
  storage_ref: string;
  workload_ref: string | null;
  observed_state: string;
  observed_detail: string | null;
  observed_at: Date | null;
  ready_generation: number | null;
  applied_resources: Share | null;
}


export interface RuntimeRow {
  agent_id: string;
  preset_id: string;
  pending_preset_id: string | null;
  generation: number;
  namespace: string;
  workload_ref: string | null;
  storage_ref: string | null;
  observed_state: string;
  observed_detail: string | null;
  observed_at: Date | null;
  ready_generation: number | null;
  applied_secret_rev: string | null;
  /** Still has a per-agent pod from before team runtimes. */
  legacy_pod: boolean;
}

export interface TaskRow {
  id: string;
  project_id: string | null;
  parent_task_id: string | null;
  title: string;
  description: string;
  acceptance_criteria: string;
  spec: TaskSpec;
  status: TaskStatus;
  status_reason: string | null;
  assignee_agent_id: string | null;
  created_by: string;
  requires_review: boolean;
  input_task_ids: string[];
  attempt: number;
  max_attempts: number;
  summary: string | null;
  campaign_id: string | null;
  campaign_step: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface CampaignRow {
  id: string;
  org_id: string;
  project_id: string;
  title: string;
  goal: string;
  mode: "auto" | "manual";
  status: "active" | "achieved" | "failed" | "stopped";
  lead_agent_id: string | null;
  max_failures: number;
  max_steps: number;
  failure_base: number;
  step_base: number;
  summary: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

/** Tasks still in play: a campaign waits for these before its next step. */
const OPEN_TASK = "('queued','assigned','in_progress','review','blocked')";

interface Ctx {
  c: pg.PoolClient;
  events: AgentEventRow[];
}

interface EventInput {
  type: string;
  agentId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  payload?: Record<string, unknown>;
}


export function namespaceFor(departmentId: string): string {
  return `agentown-${departmentId}`;
}

/** The organization owner: holds every permission implicitly. */
export function isOwner(actor: Actor): boolean {
  return actor.kind === "human" && actor.owner;
}

/** A person as a member of one organization (account joined with membership). */
export interface UserRow {
  id: string;
  display_name: string;
  role_id: string | null;
  is_owner: boolean;
  disabled_at: Date | null;
  created_by: string;
  created_at: Date;
}




/**
 * Organization service: every mutation goes through here, is authorized against
 * the authenticated actor (never a client-supplied id), audited, and emits events
 * only after its transaction commits.
 */
export class Service {
  constructor(
    readonly db: Db,
    readonly config: OrgConfig,
    readonly bus: EventBus,
    readonly secrets: SecretBox,
    private readonly modelLister: ModelLister,
    /** Every query this instance makes is confined to this organization. */
    readonly orgId: string,
    /** Kubernetes namespace for this org's new runtimes; null = one per department (orgs from before multi-org). */
    readonly runtimeNamespace: string | null = null,
  ) {
    this.kernel = new Kernel(db, config, orgId, secrets);
  }

  /**
   * Set by Instance.org from the organization row. pausing: no new work starts, runs in flight finish;
   * paused: nothing runs (no runtimes); starting: paused, queued to start once the running one has stopped.
   * People can only look while it is not running.
   */
  runState: "running" | "pausing" | "paused" | "starting" = "running";

  /** Rules, identity, resources and permissions of this organization. */
  readonly kernel: Kernel;

  // ---------------------------------------------------------------- plumbing

  private async withTx<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
    const events: AgentEventRow[] = [];
    const out = await tx(this.db, (c) => fn({ c, events }));
    this.bus.publish(events);
    return out;
  }

  private async emit(ctx: Ctx, e: EventInput): Promise<void> {
    const { rows } = await ctx.c.query(
      `INSERT INTO agent_events(org_id, agent_id, task_id, run_id, type, payload) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING seq, at`,
      [this.orgId, e.agentId ?? null, e.taskId ?? null, e.runId ?? null, e.type, JSON.stringify(sanitize(e.payload ?? {}))],
    );
    ctx.events.push({
      orgId: this.orgId,
      seq: Number(rows[0].seq),
      at: rows[0].at.toISOString(),
      agentId: e.agentId ?? null,
      taskId: e.taskId ?? null,
      runId: e.runId ?? null,
      type: e.type,
      payload: sanitize(e.payload ?? {}) as Record<string, unknown>,
    });
  }

  audit(...args: Parameters<Permissions["audit"]>): Promise<void> {
    return this.kernel.permissions.audit(...args);
  }

  private bumpRevision(q: Queryable): Promise<void> {
    return this.kernel.permissions.bumpRevision(q);
  }

  loadPolicy(q: Queryable = this.db): Promise<LoadedPolicy> {
    return this.kernel.permissions.load(q);
  }

  /** Authorize or throw 403. Every decision on a mutating action is audited, denials included. */
  /** Authorize or throw 403; audited by the kernel. */
  require(...args: Parameters<Permissions["require"]>): Promise<LoadedPolicy> {
    return this.kernel.permissions.require(...args);
  }

  // ---------------------------------------------------------------- tokens

  issueToken(q: Queryable, kind: "human" | "agent", principalId: string, label: string, rotate: boolean): Promise<string> {
    return this.kernel.identity.issueToken(q, kind, principalId, label, rotate);
  }

  /** Called by the runtime controller when it (re)creates an agent's credential Secret. */
  issueAgentToken(agentId: string): Promise<string> {
    return this.kernel.identity.issueAgentToken(agentId);
  }

  // ---------------------------------------------------------------- bootstrap

  /**
   * Create the config's bootstrap agents that do not exist yet. The first org
   * keeps the config keys as ids (as before multi-org); orgs made from a template
   * get fresh ids, since every org's template would otherwise say "ceo".
   */
  async seedBootstrapAgents(opts: { freshIds?: boolean } = {}): Promise<void> {
    await this.withTx(async (ctx) => {
      const ids = new Map(this.config.bootstrap.agents.map((a) => [a.key, opts.freshIds ? newId("a", 4) : a.key]));
      for (const a of this.config.bootstrap.agents) {
        const id = ids.get(a.key)!;
        const exists = await ctx.c.query("SELECT 1 FROM agents WHERE id = $1", [id]);
        if (exists.rowCount) continue;
        await this.insertAgent(ctx, {
          id,
          templateId: a.template,
          displayName: a.displayName,
          departmentId: a.department,
          reportsTo: a.reportsTo ? ids.get(a.reportsTo)! : null,
          createdBy: "owner:config",
          spawnKey: null,
          teamId: a.team ?? null,
        });
      }
    });
  }

  // ---------------------------------------------------------------- organization structure

  private requireOrgOwner(actor: Actor, what: string) {
    // Profiles, roles and job templates mint permissions: only the owner shapes them.
    if (!isOwner(actor)) throw deny(`${what} denied: only the organization's owner can change its structure`);
  }

  async getConfig(actor: Actor) {
    this.requireOrgOwner(actor, "org.config.view");
    const { rows } = await this.db.query("SELECT config, config_revision FROM organizations WHERE id=$1", [this.orgId]);
    return { revision: rows[0].config_revision as number, doc: rows[0].config as Record<string, unknown> };
  }

  /**
   * Replace the organization's structure document. Applies to new agents and new
   * role assignments; grants already handed out are copies and stay as they are.
   * `parse` validates the document against the install's runtime catalog.
   */
  async replaceConfig(actor: Actor, input: { revision: number; doc: Record<string, unknown> }, parse: (doc: Record<string, unknown>) => OrgConfig) {
    this.requireOrgOwner(actor, "org.config.update");
    const { organization: _o, runtimeCatalog: _r, format: _f, meta: _m, ...rawDoc } = input.doc;
    const doc = worldIdentities(rawDoc);
    return this.withTx(async (ctx) => {
      const { rows } = await ctx.c.query("SELECT config_revision FROM organizations WHERE id=$1 FOR UPDATE", [this.orgId]);
      if (rows[0].config_revision !== input.revision) throw conflict("stale", "the organization was changed meanwhile; reload and try again");
      let next: OrgConfig;
      try {
        next = parse(doc);
      } catch (err) {
        throw badRequest(err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message);
      }
      const departments = new Set(next.departments.map((d) => d.id));
      const staffed = await ctx.c.query<{ d: string }>("SELECT DISTINCT department_id AS d FROM agents WHERE org_id=$1 AND lifecycle_state <> 'retired'", [this.orgId]);
      for (const { d } of staffed.rows) if (!departments.has(d)) throw badRequest(`department ${d} still has agents: move or retire them first`);
      const teams = new Map(teamsOf(next).map((t) => [t.id, t.department]));
      const inTeams = await ctx.c.query<{ t: string; d: string }>("SELECT DISTINCT team_id AS t, department_id AS d FROM agents WHERE org_id=$1 AND team_id IS NOT NULL AND lifecycle_state <> 'retired'", [this.orgId]);
      for (const { t, d } of inTeams.rows) if (teams.get(t) !== d) throw badRequest(`team ${t} still has agents: move or retire them first`);
      const projects = new Set(next.projects.map((p) => p.id));
      const open = await ctx.c.query<{ p: string }>(
        "SELECT DISTINCT project_id AS p FROM tasks WHERE org_id=$1 AND project_id IS NOT NULL AND status NOT IN ('done','cancelled','failed')",
        [this.orgId],
      );
      for (const { p } of open.rows) if (!projects.has(p)) throw badRequest(`project ${p} still has open tasks`);
      await this.requireAssets(ctx.c, next.world);
      const upd = await ctx.c.query<{ config_revision: number }>(
        "UPDATE organizations SET config=$2, config_revision=config_revision+1 WHERE id=$1 RETURNING config_revision",
        [this.orgId, JSON.stringify(doc)],
      );
      const revision = upd.rows[0]!.config_revision;
      await this.audit(ctx.c, actor, "org.config.update", this.orgId, true, "organization owner", {
        revision,
        departments: next.departments.length,
        projects: next.projects.length,
        agentTemplates: next.agentTemplates.length,
        policyProfiles: Object.keys(next.policyProfiles).length,
        humanRoles: Object.keys(next.humanRoles).length,
      });
      await this.emit(ctx, { type: "org.config", payload: { revision } });
      return { revision, doc };
    });
  }

  /**
   * Template language: agents write in it from their next run, chats default to
   * it, and the names the template brought (departments, rooms, objects…) switch
   * over. Names the owner wrote themselves are left as they are.
   */
  async setLanguage(actor: Actor, language: Language) {
    this.requireOrgOwner(actor, "org.language");
    return this.withTx(async (ctx) => {
      const { rows } = await ctx.c.query<{ config: Record<string, unknown>; language: Language }>("SELECT config, language FROM organizations WHERE id=$1 FOR UPDATE", [this.orgId]);
      const from = rows[0]!.language;
      if (from === language) return { language };
      const upd = await ctx.c.query<{ config_revision: number }>(
        "UPDATE organizations SET language=$2, config=$3, config_revision=config_revision+1 WHERE id=$1 RETURNING config_revision",
        [this.orgId, language, JSON.stringify(translateNames(rows[0]!.config, from, language))],
      );
      const revision = upd.rows[0]!.config_revision;
      await this.audit(ctx.c, actor, "org.language", this.orgId, true, "organization owner", { from, to: language, revision });
      await this.emit(ctx, { type: "org.config", payload: { revision, part: "language" } });
      return { language, revision };
    });
  }

  /** Kernel settings (owner only): how agents' world edits are approved. */
  async setKernelSettings(actor: Actor, change: { worldEdits?: "approve" | "auto"; approver?: "owner" | "lead" }) {
    this.requireOrgOwner(actor, "org.kernel");
    return this.withTx(async (ctx) => {
      const { rows } = await ctx.c.query<{ config: Record<string, unknown> }>("SELECT config FROM organizations WHERE id=$1 FOR UPDATE", [this.orgId]);
      const config = rows[0]!.config;
      const kernel = { ...((config.kernel as Record<string, unknown> | undefined) ?? {}), ...change };
      const upd = await ctx.c.query<{ config_revision: number }>(
        "UPDATE organizations SET config=$2, config_revision=config_revision+1 WHERE id=$1 RETURNING config_revision",
        [this.orgId, JSON.stringify({ ...config, kernel })],
      );
      const revision = upd.rows[0]!.config_revision;
      await this.audit(ctx.c, actor, "org.kernel", this.orgId, true, "organization owner", { ...change, revision });
      await this.emit(ctx, { type: "org.config", payload: { revision, part: "kernel" } });
      return { kernel, revision };
    });
  }

  /** The agent at the top of the organization (no manager; the earliest if several): with approver "lead", it decides agents' requests. */
  async leadAgentId(q: Queryable = this.db): Promise<string | null> {
    const { rows } = await q.query<{ id: string }>(
      "SELECT id FROM agents WHERE org_id=$1 AND reports_to IS NULL AND lifecycle_state <> 'retired' ORDER BY created_at, id LIMIT 1",
      [this.orgId],
    );
    return rows[0]?.id ?? null;
  }

  /** A request waits for the lead: it gets a task to look at it and decide (`agentown decide`). */
  async requestLeadReview(leadId: string, proposalId: string, proposer: Actor, what: string, args: unknown, fromTask: string | null) {
    const who = proposer.kind === "agent" ? (await this.getAgentRow(proposer.id)).display_name : "someone";
    const from = fromTask ? (await this.getTaskRow(fromTask)).title : null;
    const vi = this.config.organization.language === "vi";
    await this.createTask(await this.ownerActor(), {
      title: `${vi ? "Duyệt" : "Review"}: ${what} — ${who}`.slice(0, 200),
      description: [
        `${who} asks to run "${what}"${from ? ` while working on "${from}"` : ""}. The owner lets you decide requests like this.`,
        `Arguments:\n${JSON.stringify(args, null, 2).slice(0, 4000)}`,
        `Check it makes sense for the organization (look things up with \`agentown tool inspect ...\` if needed), then run \`agentown decide ${proposalId} approve --note "why"\` or \`agentown decide ${proposalId} reject --note "why"\`. Approving runs it; ${who}'s task resumes either way.`,
      ].join("\n\n"),
      assigneeAgentId: leadId,
      requiresReview: false,
      spec: { kind: "prompt" },
      idempotencyKey: `review-${proposalId}`,
    }).catch(async (err) => {
      // The lead cannot take it (no API key, say): the owner decides after all.
      console.warn(`[review ${proposalId}]`, (err as Error).message);
      await this.db.query(`UPDATE proposals SET approvers='{"kind":"owner"}'::jsonb, updated_at=now() WHERE id=$1 AND status='pending'`, [proposalId]);
    });
  }

  /** The organization's owner, for work done on their authority (the lead approving under the kernel setting). */
  async ownerActor(): Promise<Actor> {
    const { rows } = await this.db.query<{ user_id: string }>("SELECT user_id FROM org_members WHERE org_id=$1 AND is_owner ORDER BY user_id LIMIT 1", [this.orgId]);
    if (!rows[0]) throw conflict("no_owner", "this organization has no owner");
    return { kind: "human", id: rows[0].user_id, owner: true };
  }

  /** Every asset a world uses must be in this organization's library. */
  private async requireAssets(q: Queryable, world: World | undefined) {
    const ids = worldAssets(world);
    if (!ids.length) return;
    const { rows } = await q.query<{ id: string }>("SELECT id FROM assets WHERE org_id=$1 AND id = ANY($2)", [this.orgId, ids]);
    const have = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !have.has(id));
    if (missing.length) throw badRequest(`the world uses assets that are not in this organization's library: ${missing.join(", ")}`);
  }

  // ---------------------------------------------------------------- world & art (org.design)

  private requireMember(actor: Actor, what: string) {
    if (actor.kind !== "human") throw deny(`${what}: for people`);
  }

  async getWorld(actor: Actor) {
    this.requireMember(actor, "world");
    const { rows } = await this.db.query("SELECT config, config_revision FROM organizations WHERE id=$1", [this.orgId]);
    return { revision: rows[0].config_revision as number, world: (rows[0].config.world ?? null) as Record<string, unknown> | null };
  }

  /**
   * Replace the world (floors, rooms, objects, looks) and nothing else. A
   * world never grants anything, so org.design is enough; the rest of the
   * document stays the owner's.
   */
  async replaceWorld(actor: Actor, input: { revision: number; world: Record<string, unknown> | null }, parse: (doc: Record<string, unknown>) => OrgConfig) {
    await this.require(actor, "org.design", {}, { auditAs: "org.world.update" });
    return this.withTx(async (ctx) => {
      const { rows } = await ctx.c.query("SELECT config, config_revision FROM organizations WHERE id=$1 FOR UPDATE", [this.orgId]);
      if (rows[0].config_revision !== input.revision) throw conflict("stale", "the organization was changed meanwhile; reload and try again");
      const { world: _old, ...rest } = rows[0].config as Record<string, unknown>;
      const doc = worldIdentities(input.world ? { ...rest, world: input.world } : rest);
      let next: OrgConfig;
      try {
        next = parse(doc);
      } catch (err) {
        throw badRequest(err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message);
      }
      await this.requireAssets(ctx.c, next.world);
      const upd = await ctx.c.query<{ config_revision: number }>(
        "UPDATE organizations SET config=$2, config_revision=config_revision+1 WHERE id=$1 RETURNING config_revision",
        [this.orgId, JSON.stringify(doc)],
      );
      const revision = upd.rows[0]!.config_revision;
      await this.emit(ctx, { type: "org.config", payload: { revision, part: "world" } });
      return { revision, world: (doc as Record<string, unknown>).world ?? null };
    });
  }

  // ---------------------------------------------------------------- what objects are doing

  /** Actions on objects still running (the rest are the objects' own rhythm, computed by viewers). */
  async objectStates() {
    const { rows } = await this.db.query("SELECT object_id, action, state, by_type, by_id, until FROM object_states WHERE org_id=$1 AND until > now()", [this.orgId]);
    return rows.map((r) => ({ objectId: r.object_id as string, action: r.action as string, state: r.state as string, by: { type: r.by_type as string, id: r.by_id as string }, until: (r.until as Date).toISOString() }));
  }

  /** Objects someone can talk to or do something with: where they are, what they are doing, what they offer. */
  /**
   * What is in the world to use: objects with actions or states, ones that talk, and the
   * ones with a job (computers, the cleaning robot, the trash can, the wall calendar).
   * For an agent's department, whether it can reach each one to do its actions.
   */
  async objectCatalog(departmentId?: string) {
    const world = this.config.world;
    if (!world) return [];
    const active = new Map((await this.objectStates()).map((x) => [x.objectId, x]));
    const rooms = new Map(world.floors.flatMap((f) => f.rooms).map((r) => [r.id, r]));
    return world.objects.flatMap((o) => {
      const k = world.kinds[o.kind];
      const use = !k ? null : isComputerKind(k) ? "a computer: agentown computer / browser" : k.cleaner ? "the cleaning robot: agentown cleanup" : k.trash ? "the trash can: agentown cleanup" : k.calendar ? "the wall calendar: agentown calendar" : null;
      if (!o.id || !k || !(k.actions.length || k.states.length || canTalk(world, o) || use)) return [];
      const a = active.get(o.id);
      const state = objectState(k, o.id, Date.now(), a ? { state: a.state, until: Date.parse(a.until) } : null);
      const room = rooms.get(o.room);
      return [{
        id: o.id, name: o.label ?? k.name, kind: k.name, room: room?.name ?? o.room, state: state?.id ?? null,
        actions: k.actions.map((x) => ({ id: x.id, name: x.name })), talks: canTalk(world, o),
        ...(use ? { use } : {}),
        ...(departmentId !== undefined ? { reachable: !room?.department || room.department === departmentId || k.behaviors.some((b) => b.type === "roam") } : {}),
      }];
    });
  }

  /**
   * Do something with a placed object. The owner may (for themself, or by
   * asking an agent); an agent only for itself and only with objects it can
   * reach: in its department's room, a shared room, or one that walks about.
   * Only an object itself may switch straight to one of its states.
   */
  async objectAction(actor: Actor, objectId: string, choice: { action: string } | { state: string }, by?: { type: "agent" | "object"; id: string }) {
    const world = this.config.world;
    const object = world?.objects.find((o) => o.id === objectId);
    const kind = object && world!.kinds[object.kind];
    if (!object || !kind) throw notFound("world object");
    const doer = by ?? (actor.kind === "agent" ? { type: "agent" as const, id: actor.id } : null);
    if (actor.kind === "agent" && (doer?.type !== "agent" || doer.id !== actor.id)) throw deny("an agent acts only for itself");
    if (actor.kind === "human" && !isOwner(actor)) throw deny("only the owner directs objects");
    if (doer?.type === "object" && doer.id !== objectId) throw deny("an object only changes itself");
    let action: { id: string; state: string; seconds: number; gesture?: string };
    if ("state" in choice) {
      if (doer?.type !== "object") throw deny("pick one of its actions");
      if (!kind.states.some((x) => x.id === choice.state)) throw badRequest(`${kind.name} has no state ${choice.state}`);
      action = { id: `state:${choice.state}`, state: choice.state, seconds: 120 };
    } else {
      const a = kind.actions.find((x) => x.id === choice.action);
      if (!a) throw badRequest(`${kind.name} has no action ${choice.action}; it can: ${kind.actions.map((x) => x.id).join(", ") || "nothing"}`);
      action = a;
    }
    if (doer?.type === "agent") {
      const agent = (await this.db.query<AgentRow>("SELECT * FROM agents WHERE org_id=$1 AND id=$2 AND lifecycle_state <> 'retired'", [this.orgId, doer.id])).rows[0];
      if (!agent) throw notFound("agent");
      const room = world!.floors.flatMap((f) => f.rooms).find((r) => r.id === object.room);
      const reachable = !room?.department || room.department === agent.department_id || kind.behaviors.some((b) => b.type === "roam");
      if (!reachable) throw deny(`${agent.display_name} cannot reach ${object.label ?? kind.name}: it is in another department's room`);
    }
    const who = doer ?? { type: "human" as const, id: actor.id };
    // Someone who walks over first gets the way there on top (the cat purrs as they come).
    const seconds = action.seconds + (doer?.type === "agent" && (action.gesture ?? "none") !== "none" ? 20 : 0);
    return this.withTx(async (ctx) => {
      const { rows } = await ctx.c.query(
        `INSERT INTO object_states(org_id, object_id, action, state, by_type, by_id, until) VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7))
         ON CONFLICT (org_id, object_id) DO UPDATE SET action=EXCLUDED.action, state=EXCLUDED.state, by_type=EXCLUDED.by_type, by_id=EXCLUDED.by_id, until=EXCLUDED.until, at=now()
         RETURNING until`,
        [this.orgId, objectId, action.id, action.state, who.type, who.id, seconds],
      );
      const out = { objectId, action: action.id, state: action.state, by: who, until: (rows[0].until as Date).toISOString() };
      await this.emit(ctx, { type: "org.object", payload: out });
      return out;
    });
  }

  /** An object busy with its own work for a while (the cleaning robot sweeping); skipped when its kind has no such state. */
  async objectBusy(objectId: string, state: string, seconds: number) {
    const object = this.config.world?.objects.find((o) => o.id === objectId);
    const kind = object && this.config.world!.kinds[object.kind];
    if (!kind?.states.some((x) => x.id === state)) return null;
    return this.withTx(async (ctx) => {
      const { rows } = await ctx.c.query(
        `INSERT INTO object_states(org_id, object_id, action, state, by_type, by_id, until) VALUES ($1,$2,$3,$3,'object',$2, now() + make_interval(secs => $4))
         ON CONFLICT (org_id, object_id) DO UPDATE SET action=EXCLUDED.action, state=EXCLUDED.state, by_type=EXCLUDED.by_type, by_id=EXCLUDED.by_id, until=EXCLUDED.until, at=now()
         RETURNING until`,
        [this.orgId, objectId, state, seconds],
      );
      const out = { objectId, action: state, state, by: { type: "object", id: objectId }, until: (rows[0].until as Date).toISOString() };
      await this.emit(ctx, { type: "org.object", payload: out });
      return out;
    });
  }

  private presentAsset(r: Record<string, any>) {
    return { id: r.id as string, kind: r.kind as AssetKind, name: r.name as string, contentType: r.content_type as string, size: r.size as number, sha256: r.sha256 as string, createdAt: (r.created_at as Date).toISOString() };
  }

  async listAssets(actor: Actor) {
    this.requireMember(actor, "assets");
    const { rows } = await this.db.query("SELECT id, kind, name, content_type, size, sha256, created_at FROM assets WHERE org_id=$1 ORDER BY created_at", [this.orgId]);
    const used = await this.db.query("SELECT COALESCE(sum(size),0)::bigint AS n FROM assets WHERE org_id=$1", [this.orgId]);
    return { assets: rows.map((r) => this.presentAsset(r)), used: Number(used.rows[0].n), quota: ORG_QUOTA };
  }

  /** Members only (the office draws it); agents have no use for art. */
  async getAsset(actor: Actor, id: string) {
    this.requireMember(actor, "assets");
    const { rows } = await this.db.query("SELECT content_type, sha256, content FROM assets WHERE id=$1 AND org_id=$2", [id, this.orgId]);
    if (!rows[0]) throw notFound("asset");
    return { contentType: rows[0].content_type as string, sha256: rows[0].sha256 as string, content: rows[0].content as Buffer };
  }

  async uploadAsset(actor: Actor, input: { kind: AssetKind; name: string; content: Buffer }) {
    await this.require(actor, "org.design", {}, { auditAs: "asset.upload", detail: { name: input.name, size: input.content.length } });
    let sniffed;
    try {
      sniffed = sniffAsset(input.content, input.kind);
    } catch (err) {
      if (err instanceof AssetRejected) throw badRequest(err.message);
      throw err;
    }
    const name = input.name.replace(/[^\w .()-]+/g, "").slice(0, 80) || sniffed.kind;
    return this.withTx(async (ctx) => {
      const hash = sha256(input.content);
      const dup = await ctx.c.query("SELECT id, kind, name, content_type, size, sha256, created_at FROM assets WHERE org_id=$1 AND sha256=$2", [this.orgId, hash]);
      if (dup.rows[0]) return this.presentAsset(dup.rows[0]);
      // Serialize uploads per org so two at once cannot both slip under the quota.
      await ctx.c.query("SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE", [this.orgId]);
      const used = await ctx.c.query("SELECT COALESCE(sum(size),0)::bigint AS n FROM assets WHERE org_id=$1", [this.orgId]);
      if (Number(used.rows[0].n) + input.content.length > ORG_QUOTA) throw new ApiError(413, "quota", "the organization's asset library is full (200 MiB)");
      const id = newId("as");
      const { rows } = await ctx.c.query(
        `INSERT INTO assets(id, org_id, kind, name, content_type, size, sha256, content, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, kind, name, content_type, size, sha256, created_at`,
        [id, this.orgId, sniffed.kind, name, sniffed.contentType, input.content.length, hash, input.content, actorRef(actor)],
      );
      await this.emit(ctx, { type: "org.asset", payload: { assetId: id, name, kind: sniffed.kind } });
      return this.presentAsset(rows[0]);
    });
  }

  /** Removing art the world still uses is allowed: the office falls back to plain shapes. */
  async deleteAsset(actor: Actor, id: string) {
    await this.require(actor, "org.design", {}, { auditAs: "asset.delete", detail: { assetId: id } });
    const r = await this.db.query("DELETE FROM assets WHERE id=$1 AND org_id=$2", [id, this.orgId]);
    if (!r.rowCount) throw notFound("asset");
  }

  /** This organization as a template: its document plus today's agent tree as the bootstrap. */
  async asTemplateDoc(actor: Actor): Promise<Record<string, unknown>> {
    this.requireOrgOwner(actor, "org.template.save");
    const { doc } = await this.getConfig(actor);
    const { rows } = await this.db.query<AgentRow>("SELECT * FROM agents WHERE org_id=$1 AND lifecycle_state <> 'retired' ORDER BY created_at", [this.orgId]);
    const byId = new Map(rows.map((a) => [a.id, a]));
    const ordered: AgentRow[] = [];
    const placed = new Set<string>();
    const place = (a: AgentRow) => {
      if (placed.has(a.id)) return;
      placed.add(a.id);
      const boss = a.reports_to ? byId.get(a.reports_to) : undefined;
      if (boss) place(boss); // managers first: the template format requires it
      ordered.push(a);
    };
    rows.forEach(place);
    for (const a of ordered) {
      if (!this.config.agentTemplates.some((t) => t.id === a.template_id)) {
        throw badRequest(`${a.display_name} uses job template ${a.template_id}, which this organization no longer has`);
      }
    }
    // Ids and instructions stay behind: a template carries structure, never keys or prompts.
    return {
      ...doc,
      bootstrap: {
        agents: ordered.map((a) => ({
          key: a.id,
          displayName: a.display_name,
          template: a.template_id,
          department: a.department_id,
          reportsTo: a.reports_to && byId.has(a.reports_to) ? a.reports_to : null,
        })),
      },
    };
  }

  private template(id: string) {
    const t = this.config.agentTemplates.find((x) => x.id === id);
    if (!t) throw badRequest(`unknown template ${id}`);
    const preset = this.config.runtimeCatalog.find((p) => p.id === t.runtimePreset)!;
    return { template: t, preset, profile: this.config.policyProfiles[t.policyProfile]! };
  }

  private async insertAgent(
    ctx: Ctx,
    a: {
      id: string;
      templateId: string;
      displayName: string;
      departmentId: string;
      reportsTo: string | null;
      createdBy: string;
      spawnKey: string | null;
      config?: Partial<AgentConfig>;
      teamId?: string | null;
      share?: Partial<Share>;
    },
  ): Promise<void> {
    const { template, preset: templatePreset, profile } = this.template(a.templateId);
    const team = this.resolveTeam(a.departmentId, a.teamId ?? null);
    const preset = this.config.runtimeCatalog.find((p) => p.id === team.runtimePreset) ?? templatePreset;
    const cfg = a.config ?? {};
    const seat = await ctx.c.query<{ n: string }>("SELECT count(*) AS n FROM agents WHERE org_id = $1 AND department_id = $2", [this.orgId, a.departmentId]);
    await ctx.c.query(
      `INSERT INTO agents(id, department_id, display_name, job_role, template_id, reports_to, lifecycle_state,
         desired_runtime, created_by, spawn_key, seat, credential_id, model, effort, instructions, max_turns, context_limit, org_id,
         team_id, cpu_millis, memory_mib)
       VALUES ($1,$2,$3,$4,$5,$6,'provisioning','running',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        a.id,
        a.departmentId,
        a.displayName,
        template.jobRole,
        template.id,
        a.reportsTo,
        a.createdBy,
        a.spawnKey,
        Number(seat.rows[0]!.n),
        cfg.credentialId ?? null,
        cfg.model ?? null,
        cfg.effort ?? null,
        cfg.instructions ?? "",
        cfg.maxTurns ?? 40,
        cfg.contextLimit ?? null,
        this.orgId,
        team.id === a.departmentId ? null : team.id,
        a.share?.cpu ?? null,
        a.share?.memory ?? null,
      ],
    );
    // Members live in their team's runtime; this row is the member's own generation (fencing) and status mirror.
    await ctx.c.query(
      `INSERT INTO agent_runtimes(agent_id, preset_id, namespace, storage_ref, legacy_pod) VALUES ($1,$2,$3,$4,false)`,
      [a.id, preset.id, this.teamNamespace(team), `members/${a.id}`],
    );
    // Template grants were approved by the owner when they authored the config;
    // the spawner can only pick templates its own agent.spawn grant lists.
    for (const cap of profile) {
      await ctx.c.query(
        `INSERT INTO grants(id, principal_id, action, scope, constraints, delegable, issuer, org_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          newId("g"),
          a.id,
          cap.action,
          JSON.stringify(cap.scope),
          JSON.stringify({ ...(cap.templates ? { templates: cap.templates } : {}), ...(cap.repos ? { repos: cap.repos } : {}) }),
          cap.delegable,
          `template:${template.id}`,
          this.orgId,
        ],
      );
    }
    await this.bumpRevision(ctx.c);
    await this.emit(ctx, {
      type: "agent.spawned",
      agentId: a.id,
      payload: { displayName: a.displayName, jobRole: template.jobRole, departmentId: a.departmentId, reportsTo: a.reportsTo, createdBy: a.createdBy },
    });
  }

  // ---------------------------------------------------------------- teams

  /** The team an agent works in: its own, or its department's default team. */
  resolveTeam(departmentId: string, teamId: string | null): TeamConfig {
    return this.kernel.rules.resolveTeam(departmentId, teamId);
  }

  teamOf(a: Pick<AgentRow, "department_id" | "team_id">): TeamConfig {
    return this.kernel.rules.teamOf(a);
  }

  teamNamespace(t: TeamConfig): string {
    return this.runtimeNamespace ?? namespaceFor(t.department);
  }

  /** A member's declared share of its team runtime. */
  memberShare(a: Pick<AgentRow, "cpu_millis" | "memory_mib">, preset: RuntimePreset): Share {
    return this.kernel.resources.memberShare(a, preset);
  }

  /**
   * What each team runtime should be, for the controller: its members, preset and
   * size (preset base + every member that wants to run). Ensures the team's row.
   */
  async teamPlans(): Promise<Array<{ team: TeamConfig; runtime: TeamRuntimeRow; preset: RuntimePreset; members: AgentRow[]; resources: Share; wanted: boolean }>> {
    const { rows: agents } = await this.db.query<AgentRow>("SELECT * FROM agents WHERE org_id=$1 ORDER BY created_at", [this.orgId]);
    const { rows: rts } = await this.db.query<RuntimeRow>("SELECT r.* FROM agent_runtimes r JOIN agents a ON a.id=r.agent_id WHERE a.org_id=$1", [this.orgId]);
    const presetOf = new Map(rts.map((r) => [r.agent_id, r.preset_id]));
    const plans = [];
    for (const team of teamsOf(this.config)) {
      const members = agents.filter((a) => this.teamOf(a).id === team.id && a.lifecycle_state !== "retired");
      const { rows: existing } = await this.db.query<TeamRuntimeRow>("SELECT * FROM team_runtimes WHERE org_id=$1 AND team_id=$2", [this.orgId, team.id]);
      if (!members.length && !existing[0]) continue;
      // The team's preset; else, deterministically, the most capable shared preset its members were hired with.
      const memberPresets = new Set(members.map((a) => presetOf.get(a.id)));
      const fromMembers = [...this.config.runtimeCatalog].sort((a, b) => rank(a) - rank(b)).find((p) => memberPresets.has(p.id));
      const preset = this.config.runtimeCatalog.find((p) => p.id === team.runtimePreset)
        ?? fromMembers
        ?? this.config.runtimeCatalog.find((p) => p.id === existing[0]?.preset_id)
        ?? this.config.runtimeCatalog[0]!;
      const runtime = existing[0] ?? (await this.db.query<TeamRuntimeRow>(
        `INSERT INTO team_runtimes(org_id, team_id, runtime_id, preset_id, namespace, storage_ref) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (org_id, team_id) DO UPDATE SET org_id=EXCLUDED.org_id RETURNING *`,
        // Unique across organizations that share department namespaces (orgs from before multi-org).
        [this.orgId, team.id, `team-${team.id}-${sha256(this.orgId).slice(0, 6)}`, preset.id, this.teamNamespace(team), `team-${team.id}-${sha256(this.orgId).slice(0, 6)}-workspace`],
      )).rows[0]!;
      const running = members.filter((a) => a.desired_runtime === "running");
      const resources = running.reduce((s, a) => {
        const m = this.memberShare(a, preset);
        return { cpu: s.cpu + m.cpu, memory: s.memory + m.memory };
      }, { cpu: cpuMillis(preset.resources.cpu), memory: memoryMib(preset.resources.memory) });
      plans.push({ team, runtime, preset, members, resources, wanted: running.length > 0 && (this.runState === "running" || this.runState === "pausing") });
    }
    return plans;
  }

  /** The team runtime's preset, recorded when a runtime of that preset is created. */
  async setTeamPreset(teamId: string, presetId: string) {
    await this.db.query("UPDATE team_runtimes SET preset_id=$3 WHERE org_id=$1 AND team_id=$2", [this.orgId, teamId, presetId]);
  }

  /** Members run on their team's preset, so their harness matches (queued upgrades apply first). */
  async syncMemberPresets(members: AgentRow[], presetId: string) {
    const ids = members.map((a) => a.id);
    if (ids.length) await this.db.query("UPDATE agent_runtimes SET preset_id=$2 WHERE agent_id = ANY($1) AND pending_preset_id IS NULL AND preset_id <> $2", [ids, presetId]);
  }

  /** A new runtime generation for the whole team: every member's runs on the old one are lost and requeued. */
  async bumpTeamGeneration(teamId: string, reason: string): Promise<number> {
    return this.withTx(async (ctx) => {
      const { rows } = await ctx.c.query<{ generation: number }>(
        "UPDATE team_runtimes SET generation=generation+1, ready_generation=NULL WHERE org_id=$1 AND team_id=$2 RETURNING generation",
        [this.orgId, teamId],
      );
      const { rows: members } = await ctx.c.query<AgentRow>("SELECT * FROM agents WHERE org_id=$1 AND lifecycle_state<>'retired'", [this.orgId]);
      for (const a of members) if (this.teamOf(a).id === teamId) await this.bumpGeneration(ctx, a.id, reason);
      return rows[0]!.generation;
    });
  }

  async teamHasRunningRun(teamId: string): Promise<boolean> {
    const { rows } = await this.db.query<AgentRow>(
      "SELECT a.* FROM agents a JOIN task_runs r ON r.agent_id=a.id WHERE a.org_id=$1 AND r.status='running'",
      [this.orgId],
    );
    return rows.some((a) => this.teamOf(a).id === teamId);
  }

  /** Controller report for a team runtime; mirrored onto each member so per-agent views keep working. */
  async recordTeamObservation(plan: { team: TeamConfig; members: AgentRow[] }, obs: { state: string; detail: string | null; workloadRef: string | null; generation: number; ready: boolean; resources?: Share }) {
    const { rowCount } = await this.db.query(
      `UPDATE team_runtimes SET observed_state=$3, observed_detail=$4, workload_ref=$5, observed_at=now(),
         ready_generation=CASE WHEN $6 THEN generation ELSE NULL END,
         applied_resources=COALESCE($7::jsonb, applied_resources)
       WHERE org_id=$1 AND team_id=$2 AND generation=$8`,
      [this.orgId, plan.team.id, obs.state, obs.detail, obs.workloadRef, obs.ready, obs.resources ? JSON.stringify(obs.resources) : null, obs.generation],
    );
    if (!rowCount) return; // stale observation
    for (const a of plan.members) {
      const rt = await this.getRuntimeRow(a.id);
      const memberState = a.desired_runtime === "running" ? obs.state : "stopped";
      await this.recordObservation(a.id, { state: memberState, detail: memberState === "stopped" ? null : obs.detail, workloadRef: obs.workloadRef, generation: rt.generation, ready: obs.ready && a.desired_runtime === "running" });
    }
  }

  /** Runtime token for a team (the runtime then acts as each member with x-agentown-member). */
  issueTeamToken(teamId: string): Promise<string> {
    return this.kernel.identity.issueRuntimeToken(teamId);
  }

  /** Mark a member's per-agent pod as gone (it now runs inside its team runtime). */
  async markLegacyPodRemoved(agentId: string) {
    await this.db.query("UPDATE agent_runtimes SET legacy_pod=false WHERE agent_id=$1", [agentId]);
  }

  /** Member connection changed (key/provider): only that member restarts, and only between runs. */
  async refreshMemberConnection(a: AgentRow): Promise<boolean> {
    const rt = await this.getRuntimeRow(a.id);
    const want = await this.desiredSecretRev(a);
    if (want === rt.applied_secret_rev) return false;
    if (rt.applied_secret_rev !== null && await this.hasRunningRun(a.id)) return false;
    await this.withTx(async (ctx) => {
      if (rt.applied_secret_rev !== null) await this.bumpGeneration(ctx, a.id, "API credential changed");
      await ctx.c.query("UPDATE agent_runtimes SET applied_secret_rev=$2 WHERE agent_id=$1", [a.id, want]);
    });
    return rt.applied_secret_rev !== null;
  }

  /**
   * A member session for a team runtime: a fresh token for that member (the
   * previous one is revoked), so each member acts with exactly its own grants.
   */
  async memberSession(teamId: string, agentId: string) {
    const a = await this.getAgentRow(agentId);
    if (this.teamOf(a).id !== teamId || a.lifecycle_state === "retired" || a.desired_runtime !== "running") throw deny("not a running member of this team");
    const rt = await this.getRuntimeRow(agentId);
    const token = await this.issueToken(this.db, "agent", agentId, `team ${teamId} session`, true);
    return { token, generation: rt.generation };
  }

  /** What a team runtime needs to start its members: identity, generation and non-secret model connection. */
  async teamHello(teamId: string) {
    const team = teamsOf(this.config).find((t) => t.id === teamId);
    if (!team) throw notFound("team");
    const { rows } = await this.db.query<{ generation: number }>("SELECT generation FROM team_runtimes WHERE org_id=$1 AND team_id=$2", [this.orgId, teamId]);
    const { rows: agents } = await this.db.query<AgentRow>(
      "SELECT * FROM agents WHERE org_id=$1 AND lifecycle_state<>'retired' AND desired_runtime='running' ORDER BY created_at",
      [this.orgId],
    );
    const members = [];
    for (const a of agents) {
      if (this.teamOf(a).id !== teamId) continue;
      const rt = await this.getRuntimeRow(a.id);
      const preset = this.config.runtimeCatalog.find((p) => p.id === rt.preset_id);
      members.push({
        id: a.id,
        displayName: a.display_name,
        jobRole: a.job_role,
        generation: rt.generation,
        harness: preset?.harness ?? "script",
        model: preset?.model ?? null,
        llm: (await this.runtimeCredential(a.id)).llm,
      });
    }
    return { team: { id: team.id, name: team.name, department: team.department }, generation: rows[0]?.generation ?? 0, members };
  }

  /** Move an agent to another team (same department unless the owner does it). Its runtime moves with it. */
  async setTeam(actor: Actor, id: string, teamId: string) {
    await this.withTx(async (ctx) => {
      const agent = await this.getAgentRow(id, ctx.c, true);
      if (agent.lifecycle_state === "retired") throw conflict("retired", "agent is retired");
      await this.require(actor, "agent.update", { agentId: id }, { q: ctx.c, auditAs: "agent.team", detail: { teamId } });
      const team = teamsOf(this.config).find((t) => t.id === teamId);
      if (!team) throw badRequest(`unknown team ${teamId}`);
      if (team.department !== agent.department_id && !isOwner(actor)) throw deny("only the owner can move an agent to another department's team");
      if (this.teamOf(agent).id === team.id) return;
      if ((await ctx.c.query("SELECT 1 FROM task_runs WHERE agent_id=$1 AND status='running'", [id])).rowCount) {
        throw conflict("busy", "the agent is working on a task; move it when the task ends");
      }
      await ctx.c.query("UPDATE agents SET team_id=$2, department_id=$3 WHERE id=$1", [id, team.id === team.department ? null : team.id, team.department]);
      await ctx.c.query("UPDATE agent_runtimes SET namespace=$2 WHERE agent_id=$1", [id, this.teamNamespace(team)]);
      // The old team's runtime held this member's session: end it.
      await ctx.c.query("UPDATE tokens SET revoked_at=now() WHERE principal_kind='agent' AND principal_id=$1 AND revoked_at IS NULL", [id]);
      await this.bumpGeneration(ctx, id, `moved to team ${team.id}`);
      await this.bumpRevision(ctx.c);
      await this.emit(ctx, { type: "agent.team", agentId: id, payload: { teamId: team.id, departmentId: team.department } });
    });
    return this.presentAgentById(id);
  }

  /** Change the share an agent adds to its team runtime. The team resizes when it is next idle. */
  async setResources(actor: Actor, id: string, input: { cpu?: string; memory?: string }) {
    const share = parseShare(input);
    await this.withTx(async (ctx) => {
      await this.getAgentRow(id, ctx.c);
      await this.require(actor, "runtime.control", { agentId: id }, { q: ctx.c, auditAs: "runtime.resources", detail: input });
      await ctx.c.query("UPDATE agents SET cpu_millis=COALESCE($2, cpu_millis), memory_mib=COALESCE($3, memory_mib) WHERE id=$1", [id, share.cpu ?? null, share.memory ?? null]);
      await this.emit(ctx, { type: "agent.resources", agentId: id, payload: input });
    });
    return this.presentAgentById(id);
  }

  /** Each team with its members and runtime, as the people UI shows it. */
  async listTeams(actor: Actor) {
    const agents = await this.listAgents(actor);
    const { rows } = await this.db.query<TeamRuntimeRow>("SELECT * FROM team_runtimes WHERE org_id=$1", [this.orgId]);
    const rt = new Map(rows.map((r) => [r.team_id, r]));
    return teamsOf(this.config).map((t) => {
      const r = rt.get(t.id);
      return {
        id: t.id,
        name: t.name,
        departmentId: t.department,
        implicit: !(this.config.teams ?? []).some((x) => x.id === t.id),
        memberIds: agents.filter((a) => a.teamId === t.id && a.lifecycleState !== "retired").map((a) => a.id),
        runtime: r ? {
          presetId: r.preset_id,
          generation: r.generation,
          state: r.observed_state,
          detail: r.observed_detail,
          ready: r.observed_state === "running" && r.ready_generation === r.generation,
          resources: r.applied_resources,
        } : null,
      };
    });
  }

  // ---------------------------------------------------------------- agents

  async getAgentRow(id: string, q: Queryable = this.db, lock = false): Promise<AgentRow> {
    const { rows } = await q.query<AgentRow>(`SELECT * FROM agents WHERE id = $1 AND org_id = $2 ${lock ? "FOR UPDATE" : ""}`, [id, this.orgId]);
    if (!rows[0]) throw notFound("agent");
    return rows[0];
  }

  async getRuntimeRow(id: string, q: Queryable = this.db, lock = false): Promise<RuntimeRow> {
    const { rows } = await q.query<RuntimeRow>(
      `SELECT r.* FROM agent_runtimes r JOIN agents a ON a.id = r.agent_id WHERE r.agent_id = $1 AND a.org_id = $2${lock ? " FOR UPDATE OF r" : ""}`,
      [id, this.orgId],
    );
    if (!rows[0]) throw notFound("runtime");
    return rows[0];
  }

  async spawn(
    actor: Actor,
    input: {
      templateId: string;
      displayName: string;
      reportsToAgentId: string | null;
      departmentId?: string;
      teamId?: string;
      /** Share this member adds to its team runtime ("250m", "256Mi"); preset default when omitted. */
      resources?: { cpu?: string; memory?: string };
      idempotencyKey?: string;
      config?: Partial<AgentConfig>;
    },
  ): Promise<{ agent: ReturnType<Service["presentAgent"]>; existing: boolean }> {
    const share = parseShare(input.resources);
    this.template(input.templateId);
    const spawnKey = input.idempotencyKey ? `${actorRef(actor)}:${input.idempotencyKey}` : null;
    if (spawnKey) {
      const { rows } = await this.db.query<AgentRow>("SELECT * FROM agents WHERE org_id = $1 AND spawn_key = $2", [this.orgId, spawnKey]);
      if (rows[0]) {
        if (rows[0].template_id !== input.templateId || rows[0].reports_to !== input.reportsToAgentId) {
          throw conflict("idempotency_mismatch", "idempotency key reused with different parameters");
        }
        return { agent: await this.presentAgentById(rows[0].id), existing: true };
      }
    }
    if (!isOwner(actor) && !input.reportsToAgentId) throw deny("only the owner can hire at the top of the tree; name a manager");

    const id = await this.withTx(async (ctx) => {
      const policy = await this.loadPolicy(ctx.c);
      let departmentId = input.departmentId;
      if (input.teamId) {
        const team = teamsOf(this.config).find((t) => t.id === input.teamId);
        if (!team) throw badRequest(`unknown team ${input.teamId}`);
        if (departmentId && departmentId !== team.department) throw badRequest(`team ${team.id} belongs to department ${team.department}`);
        departmentId = team.department;
      }
      if (input.reportsToAgentId) {
        const manager = await this.getAgentRow(input.reportsToAgentId, ctx.c);
        if (manager.lifecycle_state === "retired") throw conflict("manager_retired", "manager is retired");
        departmentId ??= manager.department_id;
        if (!isOwner(actor) && departmentId !== manager.department_id) {
          throw deny("new hires join their manager's department");
        }
      }
      if (!departmentId) throw badRequest("departmentId required when there is no manager");
      if (!this.config.departments.some((d) => d.id === departmentId)) throw badRequest("unknown department");
      await this.require(
        actor,
        "agent.spawn",
        { agentId: input.reportsToAgentId ?? undefined, templateId: input.templateId },
        { policy, q: ctx.c, detail: { displayName: input.displayName, credentialId: input.config?.credentialId ?? null } },
      );
      const config = input.config ? await this.validateConfig(ctx.c, departmentId, emptyConfig(), input.config) : undefined;
      const id = newId("a", 4);
      await this.insertAgent(ctx, {
        id,
        templateId: input.templateId,
        displayName: input.displayName.slice(0, 40),
        departmentId,
        reportsTo: input.reportsToAgentId,
        createdBy: actorRef(actor),
        spawnKey,
        config,
        teamId: input.teamId ?? null,
        share,
      });
      return id;
    });
    return { agent: await this.presentAgentById(id), existing: false };
  }

  async presentAgentById(id: string) {
    const [a, r] = await Promise.all([this.getAgentRow(id), this.getRuntimeRow(id)]);
    return this.presentAgent(a, r);
  }

  presentAgent(a: AgentRow, r: RuntimeRow | undefined) {
    const now = Date.now();
    const ready = !!r && r.observed_state === "running" && r.ready_generation === r.generation;
    const stale = !a.last_heartbeat_at || now - a.last_heartbeat_at.getTime() > HEARTBEAT_STALE_MS;
    // Work state shown on the character is only what the harness reported, and
    // only while the runtime is actually up and heartbeating.
    let workState: WorkState = a.work_state;
    if (a.lifecycle_state === "retired" || !ready || stale) workState = r?.observed_state === "failed" ? "error" : "offline";
    return {
      id: a.id,
      displayName: a.display_name,
      jobRole: a.job_role,
      departmentId: a.department_id,
      teamId: this.teamOf(a).id,
      resources: (() => {
        const preset = this.config.runtimeCatalog.find((p) => p.id === r?.preset_id) ?? this.config.runtimeCatalog[0]!;
        return { ...this.memberShare(a, preset), declared: a.cpu_millis !== null || a.memory_mib !== null };
      })(),
      templateId: a.template_id,
      reportsToAgentId: a.reports_to,
      lifecycleState: a.lifecycle_state,
      seat: a.seat,
      acceptingWork: a.accepting_work,
      desiredRuntime: a.desired_runtime,
      work: { state: workState, reported: a.work_state, detail: a.work_detail, updatedAt: a.work_updated_at?.toISOString() ?? null },
      lastHeartbeatAt: a.last_heartbeat_at?.toISOString() ?? null,
      config: this.agentConfig(a),
      configRevision: a.config_revision,
      runtime: r
        ? {
            presetId: r.preset_id,
            generation: r.generation,
            namespace: r.namespace,
            workloadRef: r.workload_ref,
            storageRef: r.storage_ref,
            state: r.observed_state,
            detail: r.observed_detail,
            observedAt: r.observed_at?.toISOString() ?? null,
            ready,
          }
        : null,
    };
  }

  async listAgents(actor: Actor) {
    const policy = await this.loadPolicy();
    const [{ rows: agents }, { rows: runtimes }] = await Promise.all([
      this.db.query<AgentRow>("SELECT * FROM agents WHERE org_id=$1 ORDER BY created_at", [this.orgId]),
      this.db.query<RuntimeRow>("SELECT r.* FROM agent_runtimes r JOIN agents a ON a.id = r.agent_id WHERE a.org_id=$1", [this.orgId]),
    ]);
    const rt = new Map(runtimes.map((r) => [r.agent_id, r]));
    return agents
      .filter((a) => authorize(actor, "org.view", { agentId: a.id }, policy).allowed)
      .map((a) => this.presentAgent(a, rt.get(a.id)));
  }

  async getAgent(actor: Actor, id: string) {
    await this.getAgentRow(id);
    const policy = await this.require(actor, "org.view", { agentId: id });
    const agent = await this.presentAgentById(id);
    const grants = policy.grants.filter((g) => g.principalId === id);
    // Tell the caller what *they* may do to this agent, so the UI can show/hide
    // controls. The server still re-checks every call.
    const can: Partial<Record<Action, boolean>> = {};
    for (const a of ["task.create", "task.assign", "task.review", "runtime.control", "runtime.logs", "runtime.exec", "agent.update", "agent.retire", "agent.configure", "permission.delegate"] as const) {
      can[a] = authorize(actor, a, { agentId: id }, policy).allowed;
    }
    const spawnTemplates = this.config.agentTemplates
      .filter((t) => authorize(actor, "agent.spawn", { agentId: id, templateId: t.id }, policy).allowed)
      .map((t) => t.id);
    can["agent.spawn"] = spawnTemplates.length > 0;
    const cred = agent.config.credentialId ? await this.getCredentialRow(agent.config.credentialId).catch(() => undefined) : undefined;
    return { ...agent, grants, can, spawnTemplates, credential: cred ? this.presentCredential(cred) : null };
  }

  async updateAgent(actor: Actor, id: string, input: { displayName?: string; reportsToAgentId?: string | null }) {
    await this.withTx(async (ctx) => {
      const agent = await this.getAgentRow(id, ctx.c);
      const policy = await this.require(actor, "agent.update", { agentId: id }, { q: ctx.c, detail: input });
      if (input.reportsToAgentId !== undefined && input.reportsToAgentId !== agent.reports_to) {
        if (input.reportsToAgentId === null) {
          if (!isOwner(actor)) throw deny("only the owner can detach an agent from the tree");
        } else {
          await this.getAgentRow(input.reportsToAgentId, ctx.c);
          // Moving someone under a new manager needs authority over that manager too.
          await this.require(actor, "agent.update", { agentId: input.reportsToAgentId }, { policy, q: ctx.c, auditAs: "agent.update.manager" });
          if (policy.graph.wouldCreateCycle(id, input.reportsToAgentId)) throw conflict("cycle", "reporting relation would create a cycle");
        }
        await ctx.c.query("UPDATE agents SET reports_to = $2 WHERE id = $1", [id, input.reportsToAgentId]);
        await this.bumpRevision(ctx.c);
      }
      if (input.displayName) await ctx.c.query("UPDATE agents SET display_name = $2 WHERE id = $1", [id, input.displayName.slice(0, 40)]);
      await this.emit(ctx, { type: "agent.updated", agentId: id, payload: input });
    });
    return this.presentAgentById(id);
  }

  async setIntake(actor: Actor, id: string, accepting: boolean) {
    await this.withTx(async (ctx) => {
      await this.getAgentRow(id, ctx.c);
      await this.require(actor, "runtime.control", { agentId: id }, { q: ctx.c, auditAs: accepting ? "agent.resume" : "agent.pause" });
      await ctx.c.query("UPDATE agents SET accepting_work = $2 WHERE id = $1", [id, accepting]);
      await this.emit(ctx, { type: "agent.intake", agentId: id, payload: { acceptingWork: accepting } });
    });
    return this.presentAgentById(id);
  }

  /** start/stop set desired state; restart bumps the generation so the controller replaces the pod. */
  async setRuntime(actor: Actor, id: string, op: "start" | "stop" | "restart") {
    await this.withTx(async (ctx) => {
      const agent = await this.getAgentRow(id, ctx.c);
      if (agent.lifecycle_state === "retired") throw conflict("retired", "agent is retired");
      await this.require(actor, "runtime.control", { agentId: id }, { q: ctx.c, auditAs: `runtime.${op}` });
      if (op === "stop") {
        await ctx.c.query("UPDATE agents SET desired_runtime='stopped' WHERE id=$1", [id]);
        // Work in flight on the stopped runtime is abandoned and requeued.
        await this.bumpGeneration(ctx, id, `stop requested by ${actorRef(actor)}`);
      } else {
        await ctx.c.query("UPDATE agents SET desired_runtime='running' WHERE id=$1", [id]);
        // start after a failure and restart both mean "new runtime generation".
        const rt = await this.getRuntimeRow(id, ctx.c);
        if (op === "restart" || rt.observed_state === "failed") await this.bumpGeneration(ctx, id, `${op} requested by ${actorRef(actor)}`);
      }
      await this.emit(ctx, { type: "runtime.desired", agentId: id, payload: { op } });
    });
    return this.presentAgentById(id);
  }

  /** New runtime generation: runs bound to the old one can no longer report or complete. */
  async bumpGeneration(ctx: Ctx, agentId: string, reason: string): Promise<number> {
    const { rows } = await ctx.c.query<{ generation: number }>(
      "UPDATE agent_runtimes SET generation = generation + 1, ready_generation = NULL WHERE agent_id = $1 RETURNING generation",
      [agentId],
    );
    const gen = rows[0]!.generation;
    const lost = await ctx.c.query<{ id: string; task_id: string }>(
      "UPDATE task_runs SET status='lost', finished_at=now(), summary=$2 WHERE agent_id=$1 AND status='running' RETURNING id, task_id",
      [agentId, `runtime replaced (${reason})`],
    );
    for (const r of lost.rows) await this.requeueAfterLostRun(ctx, r.task_id, r.id, "runtime replaced");
    await this.emit(ctx, { type: "runtime.generation", agentId, payload: { generation: gen, reason } });
    return gen;
  }

  private async requeueAfterLostRun(ctx: Ctx, taskId: string, runId: string, why: string) {
    const { rows } = await ctx.c.query<TaskRow>("SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [taskId]);
    const t = rows[0];
    if (!t || t.status !== "in_progress") return;
    if (t.attempt >= t.max_attempts) {
      await this.setTaskStatus(ctx, t, "failed", `${why}; gave up after ${t.attempt} attempts`);
    } else {
      await ctx.c.query("UPDATE tasks SET attempt = attempt + 1 WHERE id=$1", [taskId]);
      await this.setTaskStatus(ctx, t, "assigned", `${why}; retrying (attempt ${t.attempt + 1})`);
    }
    await this.emit(ctx, { type: "run.lost", agentId: t.assignee_agent_id, taskId, runId, payload: { why } });
  }

  async retire(actor: Actor, id: string, purgeWorkspace: boolean) {
    await this.withTx(async (ctx) => {
      const agent = await this.getAgentRow(id, ctx.c);
      if (agent.lifecycle_state === "retired") return;
      await this.require(actor, "agent.retire", { agentId: id }, { q: ctx.c, detail: { purgeWorkspace } });
      const reports = await ctx.c.query("SELECT 1 FROM agents WHERE reports_to=$1 AND lifecycle_state <> 'retired'", [id]);
      if (reports.rowCount) throw conflict("has_reports", "reassign direct reports before retiring this agent");
      await ctx.c.query(
        "UPDATE agents SET lifecycle_state='retired', desired_runtime='stopped', accepting_work=false, retired_at=now() WHERE id=$1",
        [id],
      );
      await ctx.c.query("UPDATE agent_runtimes SET storage_ref = CASE WHEN $2 THEN NULL ELSE storage_ref END WHERE agent_id=$1", [
        id,
        purgeWorkspace,
      ]);
      await ctx.c.query("UPDATE tokens SET revoked_at=now() WHERE principal_kind='agent' AND principal_id=$1 AND revoked_at IS NULL", [id]);
      await this.bumpRevision(ctx.c);
      await this.emit(ctx, { type: "agent.retired", agentId: id, payload: { purgeWorkspace } });
    });
    return this.presentAgentById(id);
  }

  async logs(actor: Actor, id: string, after: number) {
    await this.getAgentRow(id);
    await this.require(actor, "runtime.logs", { agentId: id });
    const { rows } = await this.db.query(
      "SELECT seq, at, run_id, stream, line FROM agent_logs WHERE agent_id=$1 AND seq > $2 ORDER BY seq LIMIT 500",
      [id, after],
    );
    return rows.map((r) => ({ seq: Number(r.seq), at: r.at, runId: r.run_id, stream: r.stream, line: r.line }));
  }

  // ---------------------------------------------------------------- credentials & per-agent config

  agentConfig(a: AgentRow): AgentConfig {
    return { credentialId: a.credential_id, model: a.model, effort: a.effort, instructions: a.instructions, maxTurns: a.max_turns, contextLimit: a.context_limit };
  }

  /** What the harness needs per run; the provider key never leaves the server. */
  async runConfig(a: AgentRow, q: Queryable = this.db) {
    // The runtime's own preset, never the template: templates can be edited or removed while agents run.
    const rt = await this.getRuntimeRow(a.id, q);
    const preset = this.config.runtimeCatalog.find((p) => p.id === rt.preset_id);
    if (!preset) throw conflict("preset_gone", `runtime preset ${rt.preset_id} is no longer in the catalog`);
    const provider = a.credential_id
      ? ((await q.query<{ provider: Provider }>("SELECT provider FROM credentials WHERE id=$1 AND org_id=$2", [a.credential_id, this.orgId])).rows[0]?.provider ?? null)
      : null;
    return {
      harness: preset.harness,
      provider,
      // The preset's default model is a Claude model: only meaningful with an Anthropic key.
      model: a.model ?? (provider === null || provider === "anthropic" ? (preset.model ?? null) : null),
      effort: a.effort,
      // The job's own instructions (how the work is done here), then the agent's.
      instructions: [languageInstruction(this.config.organization.language), this.config.agentTemplates.find((t) => t.id === a.template_id)?.instructions, a.instructions].filter(Boolean).join("\n\n"),
      maxTurns: a.max_turns,
      contextLimit: a.context_limit,
      hasCredential: !!a.credential_id,
    };
  }

  presentCredential(r: CredentialRow) {
    return {
      id: r.id,
      name: r.name,
      provider: r.provider,
      keyHint: r.key_hint ? "Hidden" : "(no key)",
      workspaceId: r.workspace_id,
      baseUrl: providerBaseUrl(r.provider, r.base_url),
      protocol: apiProtocol(r.provider, r.api_protocol),
      authHeader: r.auth_header ?? defaultAuthHeader(apiProtocol(r.provider, r.api_protocol)),
      models: r.models,
      departments: r.departments,
      revision: r.revision,
      createdBy: r.created_by,
      createdAt: r.created_at.toISOString(),
      modelsRefreshedAt: r.models_refreshed_at.toISOString(),
      revokedAt: r.revoked_at?.toISOString() ?? null,
    };
  }

  private getCredentialRow(id: string, q: Queryable = this.db): Promise<CredentialRow> {
    return this.kernel.resources.credential(id, q);
  }

  /** Server-only provider target; never return this from an HTTP route or tool. */
  async ownerChatCredential(actor: Actor, id: string) {
    this.requireOrgOwner(actor, "owner.chat");
    const c = await this.getCredentialRow(id);
    if (c.revoked_at) throw conflict("revoked", "credential is revoked");
    return { provider: c.provider, apiKey: this.kernel.resources.openKey(c), workspaceId: c.workspace_id,
      baseUrl: providerBaseUrl(c.provider, c.base_url), protocol: apiProtocol(c.provider, c.api_protocol),
      authHeader: c.auth_header ?? defaultAuthHeader(apiProtocol(c.provider, c.api_protocol)), revision: c.revision, models: c.models };
  }

  private async requireCredentialManage(actor: Actor, action: string, target: string | null) {
    await this.require(actor, "credential.manage", {}, { auditAs: action, detail: { credential: target } });
  }

  private async discoverModels(provider: Provider, apiKey: string, workspaceId: string | null, customBaseUrl: string | null, protocol?: ApiProtocol, authHeader?: AuthHeader): Promise<string[]> {
    try {
      const models = await this.modelLister({ provider, apiKey, workspaceId, baseUrl: providerBaseUrl(provider, customBaseUrl), protocol, authHeader });
      if (!models.length) throw new Error("key works but lists no models");
      return models;
    } catch (err) {
      const rawMessage = String((err as Error).message ?? err);
      const message = apiKey ? rawMessage.split(apiKey).join("[redacted]") : rawMessage;
      if (provider === "anthropic" && !workspaceId && /not scoped to a workspace|anthropic-workspace-id/i.test(message)) {
        throw badRequest(
          "this API key belongs to the organization, not to a workspace: enter the ID of the workspace to use (wrkspc_…, Anthropic Console → Settings → Workspaces), or create the key inside a workspace",
        );
      }
      throw badRequest(`provider rejected the key: ${redactLine(message).slice(0, 200)}`);
    }
  }

  /**
   * Key managers see every credential, revoked ones included; anyone who may
   * configure some agent sees the active ones' metadata. Never the key.
   */
  async listCredentials(actor: Actor) {
    const policy = await this.loadPolicy();
    const me = principalOf(actor);
    const manages = authorize(actor, "credential.manage", {}, policy).allowed;
    if (!manages && !policy.grants.some((g) => g.principalId === me && g.action === "agent.configure" && isGrantEffective(g, policy))) {
      throw deny("listing credentials requires credential.manage or an agent.configure grant");
    }
    const { rows } = await this.db.query<CredentialRow>(
      `SELECT * FROM credentials WHERE org_id=$1 ${manages ? "" : "AND revoked_at IS NULL"} ORDER BY created_at`,
      [this.orgId],
    );
    return rows.map((r) => this.presentCredential(r));
  }

  async createCredential(
    actor: Actor,
    input: {
      name: string;
      provider: Provider;
      apiKey?: string | null;
      workspaceId?: string | null;
      baseUrl?: string | null;
      protocol?: ApiProtocol | null;
      authHeader?: AuthHeader | null;
      departments: string[] | null;
    },
  ) {
    await this.requireCredentialManage(actor, "credential.create", input.name);
    const info = providerInfo(input.provider);
    if (!info || !PROVIDERS.includes(input.provider)) throw badRequest("unsupported provider");
    for (const d of input.departments ?? []) if (!this.config.departments.some((x) => x.id === d)) throw badRequest(`unknown department ${d}`);
    const apiKey = input.apiKey?.trim() ?? "";
    if (apiKey && apiKey.length < 8) throw badRequest("API key must be at least 8 characters.");
    if (/[\r\n\0]/.test(apiKey)) throw badRequest("API key must not contain line breaks.");
    if (input.provider !== "custom" && (input.protocol != null || input.authHeader != null)) throw badRequest("Custom protocol and auth headers require the Custom URL provider.");
    const protocol = apiProtocol(input.provider, input.protocol);
    const parsedAuth = authHeaderSchema.safeParse(input.authHeader ?? defaultAuthHeader(protocol));
    if (!parsedAuth.success) throw badRequest("Invalid authentication header.");
    const authHeader = parsedAuth.data;
    if (info.keyRequired && apiKey.length < 8) throw badRequest(`${info.label} needs an API key`);
    const workspaceId = input.workspaceId?.trim() || null;
    if (workspaceId && protocol !== "anthropic") throw badRequest("a workspace ID only applies to Anthropic keys");
    if (workspaceId && !WORKSPACE_ID_PATTERN.test(workspaceId)) throw badRequest("workspace ID must look like wrkspc_…");
    let baseUrl: string | null = null;
    if (input.provider === "custom") {
      if (!input.baseUrl?.trim()) throw badRequest("a custom provider needs a base URL (e.g. http://ollama.internal:11434/v1)");
      try {
        baseUrl = normalizeBaseUrl(input.baseUrl);
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    } else if (input.baseUrl?.trim()) {
      throw badRequest(`${info.label} uses a fixed endpoint; choose "custom" to use your own base URL`);
    }
    const models = await this.discoverModels(input.provider, apiKey, workspaceId, baseUrl, protocol, authHeader);
    return this.withTx(async (ctx) => {
      const id = newId("k");
      await ctx.c.query(
        `INSERT INTO credentials(id, name, provider, ciphertext, key_hint, workspace_id, base_url, models, departments, created_by, org_id, api_protocol, auth_header)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          id,
          input.name.slice(0, 60),
          input.provider,
          this.kernel.resources.sealKey(apiKey),
          apiKey ? "stored" : "",
          workspaceId,
          baseUrl,
          models,
          input.departments?.length ? input.departments : null,
          actorRef(actor),
          this.orgId,
          input.provider === "custom" ? protocol : null,
          input.provider === "custom" ? JSON.stringify(authHeader) : null,
        ],
      );
      await this.emit(ctx, { type: "credential.created", payload: { credentialId: id, name: input.name, models: models.length } });
      return this.presentCredential(await this.getCredentialRow(id, ctx.c));
    });
  }

  async refreshCredentialModels(actor: Actor, id: string) {
    await this.requireCredentialManage(actor, "credential.refresh", id);
    const cred = await this.getCredentialRow(id);
    if (cred.revoked_at) throw conflict("revoked", "credential is revoked");
    const models = await this.discoverModels(cred.provider, this.kernel.resources.openKey(cred), cred.workspace_id, cred.base_url,
      apiProtocol(cred.provider, cred.api_protocol), cred.auth_header ?? defaultAuthHeader(apiProtocol(cred.provider, cred.api_protocol)));
    await this.db.query("UPDATE credentials SET models=$2, models_refreshed_at=now() WHERE id=$1 AND org_id=$3", [id, models, this.orgId]);
    return this.presentCredential(await this.getCredentialRow(id));
  }

  async updateCredentialConnection(actor: Actor, id: string, input: { revision: number; baseUrl: string; protocol: ApiProtocol; authHeader: AuthHeader; workspaceId?: string | null }) {
    this.requireOrgOwner(actor, "credential.connection");
    await this.requireCredentialManage(actor, "credential.connection", id);
    const cred = await this.getCredentialRow(id);
    if (cred.provider !== "custom") throw badRequest("Only Custom URL connections can be edited.");
    if (cred.revoked_at) throw conflict("revoked", "credential is revoked");
    if (cred.revision !== input.revision) throw conflict("revision", "This key changed. Reload its settings.");
    let baseUrl: string;
    try { baseUrl = normalizeBaseUrl(input.baseUrl); } catch (e) { throw badRequest((e as Error).message); }
    if (baseUrl !== normalizeBaseUrl(cred.base_url!)) throw badRequest("The stored key is bound to its endpoint. Add a new key to use a different URL.");
    const auth = authHeaderSchema.safeParse(input.authHeader);
    if (!auth.success) throw badRequest("Invalid authentication header.");
    const workspaceId = input.workspaceId?.trim() || null;
    if (workspaceId && (input.protocol !== "anthropic" || !WORKSPACE_ID_PATTERN.test(workspaceId))) throw badRequest("A workspace ID needs Anthropic protocol and must look like wrkspc_….");
    const models = await this.discoverModels("custom", this.kernel.resources.openKey(cred), workspaceId, baseUrl, input.protocol, auth.data);
    return this.withTx(async ctx => {
      const updated = await ctx.c.query(`UPDATE credentials SET base_url=$2,api_protocol=$3,auth_header=$4,workspace_id=$5,models=$6,models_refreshed_at=now(),revision=revision+1
        WHERE id=$1 AND org_id=$7 AND revision=$8 AND revoked_at IS NULL RETURNING id`, [id, baseUrl, input.protocol, JSON.stringify(auth.data), workspaceId, models, this.orgId, input.revision]);
      if (!updated.rowCount) throw conflict("revision", "This key changed. Reload its settings.");
      await this.emit(ctx, { type: "credential.updated", payload: { credentialId: id, protocol: input.protocol, authHeader: auth.data, models: models.length } });
      return this.presentCredential(await this.getCredentialRow(id, ctx.c));
    });
  }

  /** Revoking pulls the key from every runtime that holds it (the controller replaces idle runtimes). */
  async revokeCredential(actor: Actor, id: string) {
    await this.requireCredentialManage(actor, "credential.revoke", id);
    await this.withTx(async (ctx) => {
      await this.getCredentialRow(id, ctx.c);
      await ctx.c.query("UPDATE credentials SET revoked_at=now(), revision=revision+1 WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL", [id, this.orgId]);
      await this.emit(ctx, { type: "credential.revoked", payload: { credentialId: id } });
    });
  }

  /** Merge and validate a config change for an agent in `departmentId`. */
  private async validateConfig(q: Queryable, departmentId: string, current: AgentConfig, change: Partial<AgentConfig>): Promise<AgentConfig> {
    const next: AgentConfig = { ...current, ...Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)) };
    if (change.credentialId !== undefined && change.credentialId !== current.credentialId && change.model === undefined) {
      next.model = null; // a different key may not offer the old model
    }
    if (next.effort !== null && !EFFORTS.includes(next.effort)) throw badRequest("invalid effort");
    if (!Number.isInteger(next.maxTurns) || next.maxTurns < 1 || next.maxTurns > 200) throw badRequest("maxTurns must be 1..200");
    if (next.contextLimit !== null && (!Number.isInteger(next.contextLimit) || next.contextLimit < 8192 || next.contextLimit > 1000000)) throw badRequest("contextLimit must be 8192..1000000 or null");
    next.instructions = (next.instructions ?? "").slice(0, 8000);
    if (next.credentialId) {
      const cred = await this.getCredentialRow(next.credentialId, q);
      if (cred.revoked_at) throw conflict("revoked", "credential is revoked");
      if (cred.departments && !cred.departments.includes(departmentId)) {
        throw deny(`credential ${cred.name} is not available to the ${departmentId} department`);
      }
      if (next.model && !cred.models.includes(next.model)) {
        throw badRequest(`model ${next.model} is not available with credential ${cred.name}`);
      }
    } else if (next.model) {
      throw badRequest("choose a credential before choosing a model");
    }
    return next;
  }

  async configureAgent(actor: Actor, id: string, change: Partial<AgentConfig>, options: { expectedRevision?: number; runId?: string; generation?: number } = {}) {
    const receipt = await this.withTx(async (ctx) => {
      const run = options.runId ? await this.requireOwnRun(this.requireAgent(actor), options.runId, options.generation!, ctx.c, true) : null;
      const a = await this.getAgentRow(id, ctx.c, true);
      if (a.lifecycle_state === "retired") throw conflict("retired", "agent is retired");
      await this.require(actor, "agent.configure", { agentId: id }, {
        q: ctx.c,
        detail: { credentialId: change.credentialId, model: change.model, effort: change.effort, instructionsChanged: change.instructions !== undefined },
      });
      // An agent sizes itself for its work (key, model, effort, limits); what it is told to be is its manager's to write.
      if (actor.kind === "agent" && actor.id === id && change.instructions !== undefined && change.instructions !== a.instructions) {
        throw deny("an agent tunes its own key, model, effort and limits; its instructions are set by whoever manages it");
      }
      // What a person chose for an agent stands: agents may only suggest changing it.
      const sizing = (["credentialId", "model", "effort", "maxTurns", "contextLimit"] as const).filter((k) => change[k] !== undefined);
      const current = this.agentConfig(a);
      const resizes = sizing.some((k) => change[k] !== current[k]);
      if (actor.kind === "agent" && resizes && a.config_set_by?.startsWith("human:")) {
        throw conflict("owner_configured", `a person chose ${a.display_name}'s key and model: suggest a change instead (agentown agent suggest ${id} ... --reason "why")`);
      }
      if (options.expectedRevision !== undefined && options.expectedRevision !== a.config_revision) throw conflict("stale_config", "Agent configuration changed. Reload the saved settings before editing again.");
      const next = await this.validateConfig(ctx.c, a.department_id, this.agentConfig(a), change);
      const before = { credentialId: a.credential_id, model: a.model, effort: a.effort, maxTurns: a.max_turns, contextLimit: a.context_limit };
      const after = { credentialId: next.credentialId, model: next.model, effort: next.effort, maxTurns: next.maxTurns, contextLimit: next.contextLimit };
      const configChange = { agentId: id, before, after, revision: a.config_revision + 1, changedFields: Object.keys(after).filter(k => before[k as keyof typeof before] !== after[k as keyof typeof after]), instructionsChanged: a.instructions !== next.instructions };
      await ctx.c.query(
        `UPDATE agents SET credential_id=$2, model=$3, effort=$4, instructions=$5, max_turns=$6, context_limit=$7, config_revision=config_revision+1,
           config_set_by=CASE WHEN $8 THEN $9 ELSE config_set_by END WHERE id=$1`,
        [id, next.credentialId, next.model, next.effort, next.instructions, next.maxTurns, next.contextLimit, resizes, actorRef(actor)],
      );
      await this.emit(ctx, {
        type: "agent.configured",
        agentId: id,
        ...(run ? { taskId: run.task_id, runId: run.id } : {}),
        payload: { ...after, before, after, revision: configChange.revision, changedFields: configChange.changedFields, instructionsChanged: configChange.instructionsChanged, by: actorRef(actor) },
      });
      // Already authorized and applied: the proposal record is its receipt.
      await openProposal(ctx.c, {
        orgId: this.orgId, kind: "config_change", title: `Configure ${a.display_name}: ${configChange.changedFields.join(", ") || (configChange.instructionsChanged ? "instructions" : "no change")}`,
        proposer: actorRef(actor), subject: { type: "agent", id }, payload: { change, ...(run ? { taskId: run.task_id, runId: run.id } : {}) },
        source: { type: "agent_config", id: `${id}:${configChange.revision}` }, status: "applied", receipt: configChange,
        evaluation: [{ rule: "permission", verdict: "allow", reason: "agent.configure granted" }],
      });
      return configChange;
    });
    return { ...await this.presentAgentById(id), configChange: receipt };
  }

  /** Controller-side: non-secret broker routing metadata, tagged with a revision. */
  async runtimeCredential(agentId: string): Promise<{ rev: string; llm: ModelConnection | null }> {
    const a = await this.getAgentRow(agentId);
    if (!a.credential_id) return { rev: "none", llm: null };
    const cred = await this.getCredentialRow(a.credential_id);
    if (cred.revoked_at) return { rev: `${cred.id}:revoked`, llm: null };
    return { rev: `broker-v1:${cred.id}:${cred.revision}`, llm: this.kernel.resources.connection(cred) };
  }

  /** Private server target for the caller's current generation; never a public response. */
  async runtimeProviderTarget(actor: Actor, generation: number) {
    const id = this.requireAgent(actor);
    const rt = await this.requireCurrentGeneration(id, generation, this.db);
    const agent = await this.getAgentRow(id);
    if (agent.lifecycle_state === "retired" || agent.desired_runtime !== "running") throw deny("Runtime is not active.");
    const preset = this.config.runtimeCatalog.find(p => p.id === rt.preset_id);
    if (preset?.harness !== "claude") throw deny("This runtime has no model broker access.");
    // An in-flight task keeps the configuration it claimed. Saving next-task
    // settings must not make the following model call fail with a model 403.
    const snapshot = (await this.db.query("SELECT config_snapshot FROM task_runs WHERE agent_id=$1 AND runtime_generation=$2 AND status='running' LIMIT 1", [id, generation])).rows[0]?.config_snapshot;
    const credentialId = snapshot ? snapshot.credentialId : agent.credential_id;
    if (!credentialId) throw conflict("no_credential", "No API credential is configured.");
    const cred = await this.getCredentialRow(credentialId);
    if (cred.revoked_at) throw conflict("revoked", "credential is revoked");
    if (cred.departments && !cred.departments.includes(agent.department_id)) throw deny("Runtime credential is not available to this department.");
    return { provider: cred.provider, apiKey: this.kernel.resources.openKey(cred), workspaceId: cred.workspace_id,
      baseUrl: providerBaseUrl(cred.provider, cred.base_url), protocol: apiProtocol(cred.provider, cred.api_protocol),
      authHeader: cred.auth_header ?? defaultAuthHeader(apiProtocol(cred.provider, cred.api_protocol)), models: cred.models, model: snapshot ? snapshot.model : agent.model, contextLimit: snapshot ? snapshot.contextLimit : agent.context_limit };
  }

  desiredSecretRev(a: AgentRow, q: Queryable = this.db): Promise<string> {
    return this.kernel.resources.credentialRevision(a.credential_id, q);
  }

  async markSecretApplied(agentId: string, generation: number, rev: string) {
    await this.db.query("UPDATE agent_runtimes SET applied_secret_rev=$3 WHERE agent_id=$1 AND generation=$2", [agentId, generation, rev]);
  }

  async hasRunningRun(agentId: string): Promise<boolean> {
    const { rowCount } = await this.db.query("SELECT 1 FROM task_runs WHERE agent_id=$1 AND status='running'", [agentId]);
    return !!rowCount;
  }

  // ---------------------------------------------------------------- grants

  async delegate(
    actor: Actor,
    input: { principalId: string; action: Action; scope: Scope; constraints?: GrantConstraints; delegable?: boolean; expiresAt?: string | null },
  ) {
    return this.withTx(async (ctx) => {
      await this.getAgentRow(input.principalId, ctx.c);
      const policy = await this.loadPolicy(ctx.c);
      const proposed = {
        principalId: input.principalId,
        action: input.action,
        scope: input.scope,
        constraints: input.constraints ?? {},
        delegable: input.delegable ?? false,
      };
      const d = canDelegate(actor, proposed, policy);
      await this.audit(d.allowed ? ctx.c : this.db, actor, "permission.delegate", input.principalId, d.allowed, d.reason, { ...proposed }, policy.revision);
      if (!d.allowed) throw deny(`permission.delegate denied: ${d.reason}`);
      const id = newId("g");
      await ctx.c.query(
        `INSERT INTO grants(id, principal_id, action, scope, constraints, delegable, issuer, parent_grant_id, expires_at, org_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          proposed.principalId,
          proposed.action,
          JSON.stringify(proposed.scope),
          JSON.stringify(proposed.constraints),
          proposed.delegable,
          isOwner(actor) ? "owner" : principalOf(actor),
          d.parentGrantId,
          input.expiresAt ?? null,
          this.orgId,
        ],
      );
      await this.bumpRevision(ctx.c);
      await this.emit(ctx, { type: "grant.created", agentId: input.principalId, payload: { grantId: id, action: input.action, scope: input.scope } });
      return { id };
    });
  }

  async revokeGrant(actor: Actor, grantId: string) {
    await this.withTx(async (ctx) => {
      const { rows } = await ctx.c.query<GrantRow>("SELECT * FROM grants WHERE id=$1 AND org_id=$2", [grantId, this.orgId]);
      const g = rows[0];
      if (!g) throw notFound("grant");
      const allowed = isOwner(actor) || g.issuer === principalOf(actor);
      await this.audit(allowed ? ctx.c : this.db, actor, "permission.revoke", g.principal_id, allowed, allowed ? "owner or issuer" : "only the owner or the issuer may revoke", {
        grantId,
      });
      if (!allowed) throw deny("permission.revoke denied: only the owner or the issuer may revoke");
      await ctx.c.query("UPDATE grants SET revoked_at = now(), revision = revision + 1 WHERE id=$1 AND revoked_at IS NULL", [grantId]);
      await this.bumpRevision(ctx.c);
      await this.emit(ctx, { type: "grant.revoked", agentId: g.principal_id, payload: { grantId, action: g.action } });
    });
  }

  // ---------------------------------------------------------------- tasks

  private async getTaskRow(id: string, q: Queryable = this.db, lock = false): Promise<TaskRow> {
    const { rows } = await q.query<TaskRow>(`SELECT * FROM tasks WHERE id=$1 AND org_id=$2 ${lock ? "FOR UPDATE" : ""}`, [id, this.orgId]);
    if (!rows[0]) throw notFound("task");
    return rows[0];
  }

  /** Tasks whose ids appear in input_task_ids of a task assigned to the actor (explicit sharing). */
  private async sharedTaskIds(actor: Actor, q: Queryable = this.db): Promise<Set<string>> {
    if (actor.kind !== "agent") return new Set();
    const { rows } = await q.query<{ id: string }>(
      // A campaign's lead reads every task in it (it puts the results together), even from other teams.
      `SELECT DISTINCT unnest(input_task_ids) AS id FROM tasks WHERE assignee_agent_id = $1
       UNION SELECT t.id FROM tasks t JOIN campaigns c ON c.id = t.campaign_id WHERE c.lead_agent_id = $1`,
      [actor.id],
    );
    return new Set(rows.map((r) => r.id));
  }

  private canViewTask(actor: Actor, t: TaskRow, policy: PolicyContext, shared: Set<string>): boolean {
    if (isOwner(actor)) return true;
    if ((actor.kind === "agent" && t.assignee_agent_id === actor.id) || t.created_by === actorRef(actor)) return true;
    if (shared.has(t.id)) return true;
    return authorize(actor, "task.view", { agentId: t.assignee_agent_id ?? undefined, projectId: t.project_id }, policy).allowed;
  }

  async requireTaskView(actor: Actor, id: string, q: Queryable = this.db): Promise<TaskRow> {
    const t = await this.getTaskRow(id, q);
    const policy = await this.loadPolicy(q);
    if (!this.canViewTask(actor, t, policy, await this.sharedTaskIds(actor, q))) {
      await this.audit(this.db, actor, "task.view", id, false, "not visible to actor");
      throw deny("task.view denied: task is not visible to you");
    }
    return t;
  }

  presentTask(t: TaskRow) {
    return {
      id: t.id,
      projectId: t.project_id,
      parentTaskId: t.parent_task_id,
      title: t.title,
      description: t.description,
      acceptanceCriteria: t.acceptance_criteria,
      spec: t.spec,
      status: t.status,
      statusReason: t.status_reason,
      assigneeAgentId: t.assignee_agent_id,
      createdBy: t.created_by,
      requiresReview: t.requires_review,
      inputTaskIds: t.input_task_ids,
      attempt: t.attempt,
      maxAttempts: t.max_attempts,
      summary: t.summary,
      campaignId: t.campaign_id,
      campaignStep: t.campaign_step,
      createdAt: t.created_at.toISOString(),
      updatedAt: t.updated_at.toISOString(),
    };
  }

  private promptBlockReason(a: Pick<AgentRow, "id" | "display_name" | "credential_id" | "model" | "department_id">, connection: { preset_id: string; provider: string | null; models: string[] | null; revoked_at: Date | null; departments: string[] | null } | undefined): string | null {
    const preset = this.config.runtimeCatalog.find(p => p.id === connection?.preset_id);
    if (preset?.harness === "script") return `${a.display_name} runs the script harness and cannot take prompt tasks`;
    if (!preset || preset.harness !== "claude") return `${a.display_name} needs an LLM runtime before it can take prompt tasks`;
    if (!a.credential_id || !connection?.provider) return `${a.display_name} has no API key: configure its runtime before assigning a task`;
    if (connection.revoked_at) return `${a.display_name}'s runtime API key is revoked`;
    if (connection.departments && !connection.departments.includes(a.department_id)) return `${a.display_name}'s runtime key is not available to its department`;
    const model = a.model ?? (connection.provider === "anthropic" ? preset.model ?? null : null);
    if (!model) return `${a.display_name} has no runtime model selected. Chat settings and runtime settings are independent`;
    if (!connection.models?.includes(model)) return `${a.display_name}'s runtime model is not available to its API key`;
    return null;
  }

  /** Fail before creating a task that its assigned runtime cannot execute. */
  /** An agent nobody gave a key takes one the organization has for its department, then sizes itself. */
  private async autoCredential(a: AgentRow, q: Queryable) {
    if (a.credential_id) return;
    const { rows } = await q.query<{ id: string; provider: string; models: string[] }>(
      `SELECT id, provider, models FROM credentials WHERE org_id=$1 AND revoked_at IS NULL AND cardinality(models) > 0 AND (departments IS NULL OR $2 = ANY(departments))
       ORDER BY (provider='anthropic') DESC, created_at LIMIT 1`,
      [this.orgId, a.department_id],
    );
    const key = rows[0];
    if (!key) return;
    // Its runtime's default model when the key has it, else one the key has (a balanced one first).
    const preset = this.config.runtimeCatalog.find((p) => p.id === this.template(a.template_id).template.runtimePreset);
    const model = a.model ?? (key.provider === "anthropic" && preset?.model && key.models.includes(preset.model) ? null : (key.models.find((m) => /sonnet/i.test(m)) ?? key.models[0]!));
    await q.query("UPDATE agents SET credential_id=$2, model=$3, config_set_by='auto', config_revision=config_revision+1 WHERE id=$1 AND credential_id IS NULL", [a.id, key.id, model]);
    a.credential_id = key.id;
    a.model = model;
  }

  private async requirePromptable(a: AgentRow, q: Queryable) {
    await this.autoCredential(a, q);
    const connection = (await q.query("SELECT r.preset_id,c.provider,c.models,c.revoked_at,c.departments FROM agent_runtimes r LEFT JOIN credentials c ON c.id=$2 AND c.org_id=$3 WHERE r.agent_id=$1", [a.id, a.credential_id, this.orgId])).rows[0];
    const reason = this.promptBlockReason(a, connection);
    if (reason) throw badRequest(reason);
  }

  /** Non-secret, current permission/readiness guidance for conversational task tools. */
  async chatTaskCapabilities(actor: Actor) {
    const policy = await this.loadPolicy();
    const rows = (await this.db.query("SELECT a.id,a.display_name,a.department_id,a.credential_id,a.model,r.preset_id,c.provider,c.models,c.revoked_at,c.departments FROM agents a LEFT JOIN agent_runtimes r ON r.agent_id=a.id LEFT JOIN credentials c ON c.id=a.credential_id AND c.org_id=a.org_id WHERE a.org_id=$1 AND a.lifecycle_state<>'retired' ORDER BY a.id", [this.orgId])).rows;
    const projects = [null, ...this.config.projects.map(p => p.id)];
    const targets = rows.filter(a => authorize(actor, "org.view", { agentId: a.id }, policy).allowed).map(a => {
      const createProjects = projects.filter(projectId => authorize(actor, "task.create", { agentId: a.id, projectId }, policy).allowed);
      const assignProjects = projects.filter(projectId => authorize(actor, "task.assign", { agentId: a.id, projectId }, policy).allowed);
      const reason = this.promptBlockReason(a, a);
      return { id: a.id as string, name: a.display_name as string, canCreate: createProjects.length > 0, canAssign: assignProjects.length > 0, createProjects, assignProjects, ready: !reason, reason, canPrepareRuntime: this.config.runtimeCatalog.some(p => p.id === a.preset_id && p.harness === "claude") };
    });
    return { self: actor.kind === "agent" ? actor.id : null, targets, note: "Use exact IDs and an allowed project. Chat credentials do not configure a runtime. Agents cannot approve their own work." };
  }

  private validateSpec(spec: unknown): TaskSpec {
    const s = (spec ?? { kind: "prompt" }) as TaskSpec;
    if (s.kind === "prompt") return { kind: "prompt" };
    if (s.kind === "script") {
      if (typeof s.script !== "string" || !s.script.trim() || s.script.length > 20_000) throw badRequest("invalid script");
      return { kind: "script", script: s.script };
    }
    if (s.kind === "playbook") {
      if (!PLAYBOOK_NAME.test(s.playbook ?? "")) throw badRequest("invalid playbook name");
      const args: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.args ?? {})) {
        if (!PLAYBOOK_ARG_NAME.test(k) || typeof v !== "string" || v.length > 4000) throw badRequest(`invalid playbook arg ${k}`);
        args[k] = v;
      }
      return { kind: "playbook", playbook: s.playbook, args };
    }
    throw badRequest("unknown spec kind");
  }

  async createTask(
    actor: Actor,
    input: {
      title: string;
      description?: string;
      acceptanceCriteria?: string;
      assigneeAgentId?: string | null;
      projectId?: string | null;
      parentTaskId?: string | null;
      spec?: unknown;
      inputTaskIds?: string[];
      requiresReview?: boolean;
      idempotencyKey?: string;
      campaignId?: string | null;
      /** Internal: the step a campaign's driver creates for its lead. */
      campaignStep?: number;
    },
  ) {
    const spec = this.validateSpec(input.spec);
    // Work handed out from a campaign's task belongs to the campaign too.
    if (!input.campaignId && input.parentTaskId) {
      const parent = await this.db.query<{ campaign_id: string | null }>("SELECT campaign_id FROM tasks WHERE id=$1 AND org_id=$2", [input.parentTaskId, this.orgId]);
      if (parent.rows[0]?.campaign_id) input = { ...input, campaignId: parent.rows[0].campaign_id };
    }
    if (input.campaignId) {
      // A campaign lives in one project: its tasks are in that project too.
      const c = await this.getCampaignRow(input.campaignId);
      if (input.projectId && input.projectId !== c.project_id) throw badRequest("the campaign belongs to another project");
      input = { ...input, projectId: c.project_id };
    }
    const key = input.idempotencyKey ? `${actorRef(actor)}:${input.idempotencyKey}` : null;
    if (key) {
      const { rows } = await this.db.query<TaskRow>("SELECT * FROM tasks WHERE org_id=$1 AND idempotency_key=$2", [this.orgId, key]);
      if (rows[0]) return { task: this.presentTask(rows[0]), existing: true };
    }
    const id = await this.withTx(async (ctx) => {
      const policy = await this.loadPolicy(ctx.c);
      const assignee = input.assigneeAgentId ?? null;
      if (!assignee && !isOwner(actor)) throw badRequest("name an assignee (only the owner can leave a task unassigned)");
      if (input.projectId && !this.config.projects.some((p) => p.id === input.projectId)) throw badRequest("unknown project");
      if (assignee) {
        const a = await this.getAgentRow(assignee, ctx.c);
        if (a.lifecycle_state === "retired") throw conflict("retired", "assignee is retired");
        if (spec.kind === "prompt") await this.requirePromptable(a, ctx.c);
        await this.require(actor, "task.create", { agentId: assignee, projectId: input.projectId ?? null }, { policy, q: ctx.c, detail: { title: input.title } });
        // Inline shell runs with the assignee's identity and data: treat it as exec.
        if (spec.kind === "script" && !(actor.kind === "agent" && actor.id === assignee)) {
          await this.require(actor, "runtime.exec", { agentId: assignee }, { policy, q: ctx.c, auditAs: "task.create.script" });
        }
      }
      const shared = await this.sharedTaskIds(actor, ctx.c);
      for (const ref of [...(input.inputTaskIds ?? []), ...(input.parentTaskId ? [input.parentTaskId] : [])]) {
        const t = await this.getTaskRow(ref, ctx.c);
        if (!this.canViewTask(actor, t, policy, shared)) throw deny(`cannot reference task ${ref}: not visible to you`);
      }
      const id = newId("t");
      await ctx.c.query(
        `INSERT INTO tasks(id, project_id, parent_task_id, title, description, acceptance_criteria, spec, status,
           assignee_agent_id, created_by, requires_review, input_task_ids, idempotency_key, org_id, campaign_id, campaign_step)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          id,
          input.projectId ?? null,
          input.parentTaskId ?? null,
          input.title.slice(0, 200),
          input.description ?? "",
          input.acceptanceCriteria ?? "",
          JSON.stringify(spec),
          assignee ? "assigned" : "queued",
          assignee,
          actorRef(actor),
          input.requiresReview ?? actor.kind === "human",
          input.inputTaskIds ?? [],
          key,
          this.orgId,
          input.campaignId ?? null,
          input.campaignStep ?? null,
        ],
      );
      if (assignee) {
        await ctx.c.query("INSERT INTO task_assignments(task_id, to_agent_id, by_actor) VALUES ($1,$2,$3)", [id, assignee, actorRef(actor)]);
      }
      await this.emit(ctx, {
        type: "task.created",
        agentId: assignee,
        taskId: id,
        payload: { title: input.title, assignee, createdBy: actorRef(actor), projectId: input.projectId ?? null, campaignId: input.campaignId ?? null },
      });
      return id;
    });
    return { task: this.presentTask(await this.getTaskRow(id)), existing: false };
  }

  // ---- campaigns: a goal inside a project. Manual: people add tasks and they wait. Auto: the lead agent
  // works toward the goal one step at a time (each step may hand out tasks), until it reports the goal
  // met or failed, too many of the campaign's tasks fail, or it runs out of steps.

  async getCampaignRow(id: string, q: Queryable = this.db): Promise<CampaignRow> {
    const { rows } = await q.query<CampaignRow>("SELECT * FROM campaigns WHERE id=$1 AND org_id=$2", [id, this.orgId]);
    if (!rows[0]) throw notFound("campaign");
    return rows[0];
  }

  private async presentCampaigns(rows: CampaignRow[]) {
    if (!rows.length) return [];
    const { rows: counts } = await this.db.query<{ campaign_id: string; status: string; n: string; steps: string }>(
      "SELECT campaign_id, status, count(*) AS n, count(campaign_step) AS steps FROM tasks WHERE campaign_id = ANY($1) GROUP BY campaign_id, status",
      [rows.map((r) => r.id)],
    );
    return rows.map((c) => {
      const mine = counts.filter((x) => x.campaign_id === c.id);
      const tasks: Record<string, number> = {};
      for (const x of mine) tasks[x.status] = Number(x.n);
      const steps = mine.reduce((n, x) => n + Number(x.steps), 0);
      return {
        id: c.id, projectId: c.project_id, title: c.title, goal: c.goal, mode: c.mode, status: c.status,
        leadAgentId: c.lead_agent_id, maxFailures: c.max_failures, maxSteps: c.max_steps,
        failures: Math.max(0, (tasks.failed ?? 0) - c.failure_base), steps: Math.max(0, steps - c.step_base),
        tasks, summary: c.summary, createdBy: c.created_by, createdAt: c.created_at.toISOString(), updatedAt: c.updated_at.toISOString(),
      };
    });
  }

  /** Campaigns are seen by everyone in the organization (people and agents); their tasks only by those who may see them. */
  async listCampaigns(_actor: Actor, filter: { projectId?: string } = {}) {
    const { rows } = await this.db.query<CampaignRow>(
      "SELECT * FROM campaigns WHERE org_id=$1 AND ($2::text IS NULL OR project_id=$2) ORDER BY created_at DESC LIMIT 200",
      [this.orgId, filter.projectId ?? null],
    );
    return this.presentCampaigns(rows);
  }

  async getCampaign(actor: Actor, id: string) {
    const [c] = await this.presentCampaigns([await this.getCampaignRow(id)]);
    return { campaign: c, tasks: await this.listTasks(actor, { campaign: id }) };
  }

  async createCampaign(actor: Actor, input: { projectId: string; title: string; goal: string; mode: "auto" | "manual"; leadAgentId: string; maxFailures?: number; maxSteps?: number }) {
    if (!this.config.projects.some((p) => p.id === input.projectId)) throw badRequest("unknown project");
    const id = await this.withTx(async (ctx) => {
      const lead = await this.getAgentRow(input.leadAgentId, ctx.c);
      if (lead.lifecycle_state === "retired") throw conflict("retired", "the lead is retired");
      // Leading means taking the campaign's steps as tasks: the same right as giving it a task here.
      await this.require(actor, "task.create", { agentId: lead.id, projectId: input.projectId }, { q: ctx.c, auditAs: "campaign.create", detail: { title: input.title } });
      if (input.mode === "auto") await this.requirePromptable(lead, ctx.c);
      const id = newId("cp");
      await ctx.c.query(
        `INSERT INTO campaigns(id, org_id, project_id, title, goal, mode, lead_agent_id, max_failures, max_steps, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, this.orgId, input.projectId, input.title.slice(0, 200), input.goal, input.mode, lead.id, input.maxFailures ?? 3, input.maxSteps ?? 12, actorRef(actor)],
      );
      await this.emit(ctx, { type: "campaign.updated", agentId: lead.id, payload: { campaignId: id, title: input.title, status: "active", mode: input.mode } });
      return id;
    });
    if (input.mode === "auto") await this.driveCampaign(id);
    return (await this.getCampaign(actor, id)).campaign;
  }

  /** Who may steer a campaign: whoever made it, and the owner. */
  private requireCampaignOwner(actor: Actor, c: CampaignRow) {
    if (!isOwner(actor) && actorRef(actor) !== c.created_by) throw deny("only the campaign's creator or the owner can change it");
  }

  async updateCampaign(actor: Actor, id: string, change: { mode?: "auto" | "manual"; status?: "active" | "stopped"; goal?: string; title?: string; maxFailures?: number; maxSteps?: number; leadAgentId?: string }) {
    await this.withTx(async (ctx) => {
      const c = await this.getCampaignRow(id, ctx.c);
      this.requireCampaignOwner(actor, c);
      const lead = change.leadAgentId ? await this.getAgentRow(change.leadAgentId, ctx.c) : c.lead_agent_id ? await this.getAgentRow(c.lead_agent_id, ctx.c) : null;
      if (change.leadAgentId) await this.require(actor, "task.create", { agentId: change.leadAgentId, projectId: c.project_id }, { q: ctx.c, auditAs: "campaign.update" });
      const mode = change.mode ?? c.mode;
      if (mode === "auto" && lead) await this.requirePromptable(lead, ctx.c);
      // Resuming starts the failure and step counts over from here.
      const resume = change.status === "active" && c.status !== "active";
      const counts = resume
        ? (await ctx.c.query<{ failed: string; steps: string }>("SELECT count(*) FILTER (WHERE status='failed') AS failed, count(campaign_step) AS steps FROM tasks WHERE campaign_id=$1", [id])).rows[0]!
        : null;
      await ctx.c.query(
        `UPDATE campaigns SET mode=$2, status=$3, goal=$4, title=$5, max_failures=$6, max_steps=$7, lead_agent_id=$8,
           failure_base=$9, step_base=$10, summary=CASE WHEN $11 THEN NULL ELSE summary END, updated_at=now() WHERE id=$1`,
        [id, mode, change.status ?? c.status, change.goal ?? c.goal, (change.title ?? c.title).slice(0, 200), change.maxFailures ?? c.max_failures,
          change.maxSteps ?? c.max_steps, lead?.id ?? null, counts ? Number(counts.failed) : c.failure_base, counts ? Number(counts.steps) : c.step_base, resume],
      );
      await this.audit(ctx.c, actor, "campaign.update", id, true, "campaign owner", change);
      await this.emit(ctx, { type: "campaign.updated", agentId: lead?.id ?? null, payload: { campaignId: id, title: c.title, mode, status: change.status ?? c.status } });
    });
    await this.driveCampaign(id);
    return (await this.getCampaign(actor, id)).campaign;
  }

  /** The lead (or the creator, or the owner) says the goal is met, or cannot be. */
  async finishCampaign(actor: Actor, id: string, outcome: "achieved" | "failed", summary: string) {
    await this.withTx(async (ctx) => {
      const c = await this.getCampaignRow(id, ctx.c);
      const lead = actor.kind === "agent" && actor.id === c.lead_agent_id;
      if (!lead) this.requireCampaignOwner(actor, c);
      if (c.status !== "active") throw conflict("not_active", `the campaign is already ${c.status}`);
      await this.closeCampaign(ctx, c, outcome, summary);
    });
    return (await this.getCampaign(actor, id)).campaign;
  }

  private async closeCampaign(ctx: Ctx, c: CampaignRow, outcome: "achieved" | "failed", summary: string) {
    await ctx.c.query("UPDATE campaigns SET status=$2, summary=$3, updated_at=now() WHERE id=$1", [c.id, outcome, summary.slice(0, 4000)]);
    if (outcome === "achieved") {
      // Work nobody started is no longer needed.
      const { rows } = await ctx.c.query<TaskRow>("SELECT * FROM tasks WHERE campaign_id=$1 AND status IN ('queued','assigned') FOR UPDATE", [c.id]);
      for (const t of rows) await this.setTaskStatus(ctx, t, "cancelled", "campaign achieved its goal");
    }
    await this.emit(ctx, { type: "campaign.updated", agentId: c.lead_agent_id, payload: { campaignId: c.id, title: c.title, status: outcome, summary: summary.slice(0, 300) } });
  }

  /** Every running auto campaign of this organization takes its next step if it is ready to. */
  async driveCampaigns() {
    const { rows } = await this.db.query<{ id: string }>("SELECT id FROM campaigns WHERE org_id=$1 AND mode='auto' AND status='active'", [this.orgId]);
    for (const r of rows) await this.driveCampaign(r.id).catch((err) => console.warn(`[campaign ${r.id}]`, (err as Error).message));
  }

  /**
   * One look at an auto campaign: too many failures ends it; otherwise, once none of its tasks is
   * still in play, its lead gets the next step (a task that reads the progress so far and either
   * does the work, hands parts out with --campaign, or declares the goal met or failed).
   */
  async driveCampaign(id: string) {
    const c = await this.getCampaignRow(id);
    if (c.mode !== "auto" || c.status !== "active" || !c.lead_agent_id) return;
    const { rows: tasks } = await this.db.query<TaskRow>("SELECT * FROM tasks WHERE campaign_id=$1 ORDER BY created_at", [id]);
    const failures = tasks.filter((t) => t.status === "failed").length - c.failure_base;
    const steps = tasks.filter((t) => t.campaign_step !== null).length - c.step_base;
    if (failures >= c.max_failures || (steps >= c.max_steps && !tasks.some((t) => OPEN_TASK.includes(`'${t.status}'`)))) {
      const why = failures >= c.max_failures ? `${failures} tasks failed (limit ${c.max_failures})` : `used all ${c.max_steps} steps without reaching the goal`;
      await this.withTx(async (ctx) => {
        const locked = await ctx.c.query("SELECT 1 FROM campaigns WHERE id=$1 AND status='active' FOR UPDATE", [id]);
        if (locked.rows[0]) await this.closeCampaign(ctx, c, "failed", why);
      });
      return;
    }
    if (tasks.some((t) => OPEN_TASK.includes(`'${t.status}'`))) return;
    const creator = await this.kernel.identity.parseActorRef(c.created_by).catch(() => null);
    const step = tasks.filter((t) => t.campaign_step !== null).length + 1;
    const project = this.config.projects.find((p) => p.id === c.project_id)?.name ?? c.project_id;
    const history = tasks.slice(-30).map((t) => {
      const why = t.status === "failed" || t.status === "cancelled" ? t.status_reason ?? t.summary : t.summary;
      return `- [${t.status}]${t.campaign_step ? ` step ${t.campaign_step}` : ""} ${t.title}${why ? ` — ${why.replace(/\s+/g, " ").slice(0, 300)}` : ""}`;
    });
    // What went wrong since the last step: the next one deals with it before moving on.
    const lastStep = [...tasks].reverse().find((t) => t.campaign_step !== null);
    const broken = tasks.filter((t) => (t.status === "failed" || t.status === "cancelled") && (!lastStep || t.created_at >= lastStep.created_at));
    const description = [
      `You lead the campaign "${c.title}" (id ${c.id}) in the project "${project}".`,
      `Goal: ${c.goal}`,
      `This is step ${steps + 1} of at most ${c.max_steps}. The campaign fails after ${c.max_failures} failed tasks (${Math.max(0, failures)} so far).`,
      history.length ? `Progress so far:\n${history.join("\n")}` : "Nothing has been done yet.",
      broken.length
        ? `Not finished last time: ${broken.map((t) => `"${t.title}" (${t.status})`).join(", ")}. Start by checking what each of them left undone (read its summary, files and subtasks) and finish that; only then go further.`
        : null,
      steps === 0
        ? "Before planning, make sure the goal is clear enough to act on (what counts as done, by when, any budget or limits). If something essential is missing, ask with `agentown ask \"...\" --fallback \"what you will assume\"` and stop with BLOCKED: — the campaign waits for the answer, or for the deadline."
        : null,
      `Decide the next step toward the goal. Do the work yourself in this task, and/or hand parts to others with \`agentown task create --campaign ${c.id} --to AGENT --title T --desc D\` (\`agentown agents\` lists who you can hand work to; others exist outside your reach); the next step starts once all of them have finished. If the goal needs someone you cannot hand work to, never do their part in their name and never wait on a channel they do not read: \`agentown ask\` to have the owner arrange it, then stop with BLOCKED:.`,
      `Write a short line before each command saying what you are doing; the owner follows it live.`,
      `When the goal is fully met, run \`agentown campaign done ${c.id} --summary "what was achieved"\`. If it cannot be met, run \`agentown campaign fail ${c.id} --summary "why"\`. Otherwise finish this task with a short summary of what you did; the campaign continues with its next step.`,
    ].filter(Boolean).join("\n\n");
    try {
      if (!creator) throw new Error("the campaign's creator no longer exists");
      await this.createTask(creator, {
        title: `${c.title} · ${this.config.organization.language === "vi" ? "bước" : "step"} ${step}${broken.some((t) => t.campaign_step !== null) ? (this.config.organization.language === "vi" ? " (làm lại)" : " (retry)") : ""}`,
        description,
        acceptanceCriteria: "The step moved the campaign toward its goal, or the campaign was marked done or failed.",
        assigneeAgentId: c.lead_agent_id,
        campaignId: c.id,
        campaignStep: step,
        requiresReview: false,
        spec: { kind: "prompt" },
        idempotencyKey: `campaign-${c.id}-step-${step}`,
      });
    } catch (err) {
      // Another driver made this step a moment ago: the idempotency key clashed, nothing is missing.
      if ((await this.db.query("SELECT 1 FROM tasks WHERE campaign_id=$1 AND campaign_step=$2", [id, step])).rows.length) return;
      // The lead lost its key or the creator its rights: stop rather than retry forever.
      await this.withTx(async (ctx) => {
        await ctx.c.query("UPDATE campaigns SET status='stopped', summary=$2, updated_at=now() WHERE id=$1 AND status='active'", [id, `could not start the next step: ${(err as Error).message}`.slice(0, 1000)]);
        await this.emit(ctx, { type: "campaign.updated", agentId: c.lead_agent_id, payload: { campaignId: c.id, title: c.title, status: "stopped" } });
      });
    }
  }

  async listTasks(actor: Actor, filter: { assignee?: string; status?: string; campaign?: string } = {}) {
    const policy = await this.loadPolicy();
    const shared = await this.sharedTaskIds(actor);
    const params: unknown[] = [];
    const where: string[] = [`org_id = $${params.push(this.orgId)}`];
    if (filter.assignee) where.push(`assignee_agent_id = $${params.push(filter.assignee)}`);
    if (filter.status) where.push(`status = $${params.push(filter.status)}`);
    if (filter.campaign) where.push(`campaign_id = $${params.push(filter.campaign)}`);
    const { rows } = await this.db.query<TaskRow>(
      `SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
      params,
    );
    return rows.filter((t) => this.canViewTask(actor, t, policy, shared)).map((t) => this.presentTask(t));
  }

  async getTask(actor: Actor, id: string) {
    const t = await this.requireTaskView(actor, id);
    const [runs, artifacts, assignments] = await Promise.all([
      this.db.query(
        "SELECT id, agent_id, attempt, runtime_generation, status, started_at, finished_at, summary, usage FROM task_runs WHERE task_id=$1 ORDER BY started_at",
        [id],
      ),
      this.db.query("SELECT id, name, content_type, sha256, length(content) AS size, created_at, run_id FROM artifacts WHERE task_id=$1 ORDER BY created_at", [id]),
      this.db.query("SELECT from_agent_id, to_agent_id, by_actor, at FROM task_assignments WHERE task_id=$1 ORDER BY id", [id]),
    ]);
    // What the caller may do with this task, so the UI shows only those controls.
    const policy = await this.loadPolicy();
    const target = { agentId: t.assignee_agent_id ?? undefined, projectId: t.project_id };
    const creatorOrOwner = isOwner(actor) || t.created_by === actorRef(actor);
    const manage = creatorOrOwner || authorize(actor, "task.assign", target, policy).allowed;
    const ownWork = actor.kind === "agent" && t.assignee_agent_id === actor.id;
    return {
      ...this.presentTask(t),
      runs: runs.rows,
      artifacts: artifacts.rows.map((a) => ({ ...a, size: Number(a.size) })),
      assignments: assignments.rows,
      configurationChanges: await this.taskConfigurationChanges(actor, id, policy),
      can: {
        review: t.status === "review" && !ownWork && (creatorOrOwner || authorize(actor, "task.review", target, policy).allowed),
        retry: ["failed", "blocked"].includes(t.status) && manage,
        cancel: !isTerminal(t.status) && manage,
      },
    };
  }

  private async taskConfigurationChanges(actor: Actor, id: string, policy: LoadedPolicy) {
    const { rows } = await this.db.query(`SELECT e.seq,e.at,e.run_id,e.payload,a.id,a.display_name,a.credential_id,a.model,a.effort,a.max_turns,a.context_limit,a.config_revision,r.id AS matched_run
      FROM agent_events e JOIN agents a ON a.id=e.agent_id AND a.org_id=e.org_id
      JOIN task_runs r ON r.task_id=$2 AND (e.run_id=r.id OR (e.run_id IS NULL AND e.payload->>'by'='agent:' || r.agent_id AND e.at>=r.started_at AND e.at<=COALESCE(r.finished_at,now())))
      WHERE e.org_id=$1 AND e.type='agent.configured' ORDER BY e.seq DESC LIMIT 100`, [this.orgId, id]);
    return rows.filter(r => authorize(actor, "org.view", { agentId: r.id }, policy).allowed).map(r => {
      const saved = r.payload.after ?? { credentialId: r.payload.credentialId, model: r.payload.model, effort: r.payload.effort };
      const current = { credentialId: r.credential_id, model: r.model, effort: r.effort, maxTurns: r.max_turns, contextLimit: r.context_limit };
      return { id: Number(r.seq), agentId: r.id, name: r.display_name, at: r.at, runId: r.matched_run, linked: !!r.run_id, before: r.payload.before ?? null, saved, current,
        changedSince: Object.entries(saved).some(([k, v]) => k in current && current[k as keyof typeof current] !== v), revision: r.payload.revision ?? null,
        changed: Array.isArray(r.payload.changedFields) ? !!r.payload.changedFields.length || !!r.payload.instructionsChanged : null };
    });
  }

  /** Task-scoped activity; raw runtime output retains its separate logs permission. */
  async taskProgress(actor: Actor, id: string) {
    const task = await this.requireTaskView(actor, id);
    const run = (await this.db.query("SELECT id,agent_id,status,started_at,finished_at FROM task_runs WHERE task_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1", [id])).rows[0];
    const policy = await this.loadPolicy();
    const canReadLogs = !!run && authorize(actor, "runtime.logs", { agentId: run.agent_id }, policy).allowed;
    const [events, logs] = await Promise.all([
      this.db.query(`SELECT seq,at,type,payload FROM agent_events WHERE org_id=$1 AND
        ((task_id=$2 AND type IN ('task.created','task.status','run.started','run.finished','artifact.created','harness.context')) OR
         (type='work.state' AND agent_id=$3 AND at >= $4 AND at <= COALESCE($5::timestamptz,now())))
        ORDER BY seq DESC LIMIT 60`, [this.orgId, id, run?.agent_id ?? null, run?.started_at ?? null, run?.finished_at ?? null]),
      canReadLogs ? this.db.query("SELECT seq,at,stream,line FROM agent_logs WHERE agent_id=$1 AND run_id=$2 ORDER BY seq DESC LIMIT 100", [run.agent_id, run.id]) : Promise.resolve({ rows: [] }),
    ]);
    const current = run?.status === "running" && task.status === "in_progress" && task.assignee_agent_id === run.agent_id ? await this.getAgentRow(run.agent_id) : null;
    const freshWork = current?.work_updated_at && current.work_updated_at >= run.started_at;
    return {
      taskId: id, runId: run?.id ?? null, canReadLogs,
      current: current ? { state: freshWork ? current.work_state : "thinking", detail: canReadLogs && freshWork ? redactLine(current.work_detail ?? "") : null, updatedAt: freshWork ? current.work_updated_at : null, heartbeatAt: current.last_heartbeat_at } : null,
      events: events.rows.reverse().map(e => {
        const p = e.payload;
        const message = e.type === "task.created" ? "Task created" : e.type === "task.status" ? `Status: ${p.to}` :
          e.type === "run.started" ? `Attempt ${p.attempt} started` : e.type === "run.finished" ? `Execution ${p.outcome}` :
          e.type === "artifact.created" ? `File ready: ${p.name}` : e.type === "harness.context" ? String(p.message ?? "Context updated") : ({ thinking: "Thinking", executing: "Running a command", waiting: "Waiting", blocked: "Blocked", idle: "Idle", error: "Error", offline: "Offline" }[p.state as string] ?? "Activity updated");
        return { seq: Number(e.seq), at: e.at, type: e.type, message: redactLine(message), detail: canReadLogs && e.type === "work.state" && typeof p.detail === "string" ? redactLine(p.detail).slice(0, 300) : null };
      }),
      logs: logs.rows.reverse().map(l => ({ seq: Number(l.seq), at: l.at, stream: l.stream, line: redactLine(l.line) })),
    };
  }

  private async setTaskStatus(ctx: Ctx, t: TaskRow, to: TaskStatus, reason: string | null, summary?: string | null) {
    if (t.status !== to && !canTransition(t.status, to)) throw conflict("bad_transition", `task cannot go from ${t.status} to ${to}`);
    await ctx.c.query("UPDATE tasks SET status=$2, status_reason=$3, summary=COALESCE($4, summary), updated_at=now() WHERE id=$1", [
      t.id,
      to,
      reason,
      summary ?? null,
    ]);
    await this.emit(ctx, { type: "task.status", agentId: t.assignee_agent_id, taskId: t.id, payload: { from: t.status, to, reason, title: t.title } });
    // Finished work waiting for review is a proposal; leaving review settles it.
    const source = { type: "task", id: `${t.id}:${t.attempt}` };
    if (to === "review" && t.status !== "review") {
      await openProposal(ctx.c, {
        orgId: this.orgId, kind: "task_result", title: `Review: ${t.title}`,
        proposer: t.assignee_agent_id ? `agent:${t.assignee_agent_id}` : "system", subject: { type: "task", id: t.id },
        payload: { taskId: t.id, attempt: t.attempt, summary: summary ?? t.summary ?? null },
        source, approvers: { kind: "task_reviewer", createdBy: t.created_by },
        evaluation: [{ rule: "requires_review", verdict: "require_approval", reason: "the requester asked to review results" }],
      });
    } else if (t.status === "review" && to !== "review") {
      await recordProposal(ctx.c, source, { status: to === "done" ? "applied" : to === "assigned" ? "rejected" : "withdrawn" });
    }
    t.status = to;
  }

  /** Who may manage (cancel/retry) a task: its creator, or whoever can assign work to its assignee. */
  private async requireTaskManage(actor: Actor, t: TaskRow, q: Queryable, what: string) {
    if (isOwner(actor) || t.created_by === actorRef(actor)) {
      await this.audit(q, actor, what, t.id, true, "owner or task creator");
      return;
    }
    await this.require(actor, "task.assign", { agentId: t.assignee_agent_id ?? undefined, projectId: t.project_id }, { q, auditAs: what });
  }

  async assignTask(actor: Actor, id: string, assigneeAgentId: string) {
    await this.withTx(async (ctx) => {
      const t = await this.getTaskRow(id, ctx.c, true);
      if (isTerminal(t.status)) throw conflict("terminal", `task is ${t.status}`);
      const policy = await this.loadPolicy(ctx.c);
      const a = await this.getAgentRow(assigneeAgentId, ctx.c);
      if (a.lifecycle_state === "retired") throw conflict("retired", "assignee is retired");
      if (t.spec.kind === "prompt") await this.requirePromptable(a, ctx.c);
      // Need authority over both the current and the new owner.
      if (t.assignee_agent_id && actor.kind === "agent" && t.created_by !== actorRef(actor)) {
        await this.require(actor, "task.assign", { agentId: t.assignee_agent_id, projectId: t.project_id }, { policy, q: ctx.c, auditAs: "task.assign.from" });
      }
      await this.require(actor, "task.assign", { agentId: assigneeAgentId, projectId: t.project_id }, { policy, q: ctx.c });
      if (t.spec.kind === "script") await this.require(actor, "runtime.exec", { agentId: assigneeAgentId }, { policy, q: ctx.c, auditAs: "task.assign.script" });
      await ctx.c.query("UPDATE task_runs SET status='cancelled', finished_at=now(), summary='reassigned' WHERE task_id=$1 AND status='running'", [id]);
      await ctx.c.query("INSERT INTO task_assignments(task_id, from_agent_id, to_agent_id, by_actor) VALUES ($1,$2,$3,$4)", [
        id,
        t.assignee_agent_id,
        assigneeAgentId,
        actorRef(actor),
      ]);
      const from = t.assignee_agent_id;
      await ctx.c.query("UPDATE tasks SET assignee_agent_id=$2 WHERE id=$1", [id, assigneeAgentId]);
      t.assignee_agent_id = assigneeAgentId;
      await this.setTaskStatus(ctx, t, "assigned", `assigned by ${actorRef(actor)}`);
      await this.emit(ctx, { type: "task.assigned", agentId: assigneeAgentId, taskId: id, payload: { from, to: assigneeAgentId } });
    });
    return this.getTask(actor, id);
  }

  async cancelTask(actor: Actor, id: string, reason: string) {
    await this.withTx(async (ctx) => {
      const t = await this.getTaskRow(id, ctx.c, true);
      if (isTerminal(t.status)) return;
      await this.requireTaskManage(actor, t, ctx.c, "task.cancel");
      await ctx.c.query("UPDATE task_runs SET status='cancelled', finished_at=now(), summary=$2 WHERE task_id=$1 AND status='running'", [id, reason]);
      await this.setTaskStatus(ctx, t, "cancelled", reason || `cancelled by ${actorRef(actor)}`);
    });
    return this.getTask(actor, id);
  }

  async retryTask(actor: Actor, id: string) {
    await this.withTx(async (ctx) => {
      const t = await this.getTaskRow(id, ctx.c, true);
      if (!["failed", "blocked"].includes(t.status)) throw conflict("bad_state", `only failed or blocked tasks can be retried (is ${t.status})`);
      await this.requireTaskManage(actor, t, ctx.c, "task.retry");
      await ctx.c.query("UPDATE tasks SET attempt = attempt + 1, max_attempts = GREATEST(max_attempts, attempt + 1) WHERE id=$1", [id]);
      await this.setTaskStatus(ctx, t, "assigned", `retry requested by ${actorRef(actor)}`);
    });
    return this.getTask(actor, id);
  }

  async reviewTask(actor: Actor, id: string, decision: "approve" | "reject", note: string) {
    await this.withTx(async (ctx) => {
      const t = await this.getTaskRow(id, ctx.c, true);
      if (t.status !== "review") throw conflict("bad_state", `task is ${t.status}, not in review`);
      if (actor.kind === "agent" && t.assignee_agent_id === actor.id) throw deny("cannot review your own work");
      if (isOwner(actor) || t.created_by === actorRef(actor)) {
        await this.audit(ctx.c, actor, "task.review", id, true, "owner or task creator", { decision });
      } else {
        await this.require(actor, "task.review", { agentId: t.assignee_agent_id ?? undefined, projectId: t.project_id }, { q: ctx.c, detail: { decision } });
      }
      await recordProposal(ctx.c, { type: "task", id: `${t.id}:${t.attempt}` }, {
        status: decision === "approve" ? "approved" : "rejected",
        decision: { by: actorRef(actor), verdict: decision, ...(note ? { note } : {}) },
      });
      if (decision === "approve") await this.setTaskStatus(ctx, t, "done", note || `approved by ${actorRef(actor)}`);
      else {
        await ctx.c.query("UPDATE tasks SET attempt = attempt + 1, max_attempts = GREATEST(max_attempts, attempt + 1) WHERE id=$1", [id]);
        await this.setTaskStatus(ctx, t, "assigned", `changes requested: ${note}`);
      }
    });
    return this.getTask(actor, id);
  }

  // ---------------------------------------------------------------- harness-facing

  private requireAgent(actor: Actor): string {
    if (actor.kind !== "agent") throw deny("runtime endpoints are for agent runtimes");
    return actor.id;
  }

  /** Reject calls from a runtime generation that has been replaced. */
  private async requireCurrentGeneration(agentId: string, generation: number, q: Queryable) {
    // Serialize claims with preset upgrades so an idle check cannot race a new run.
    const rt = await this.getRuntimeRow(agentId, q, true);
    if (rt.generation !== generation) {
      throw conflict("stale_runtime", `runtime generation ${generation} was replaced by ${rt.generation}`);
    }
    return rt;
  }

  async heartbeat(actor: Actor, input: { generation: number; state: WorkState; detail?: string }) {
    const agentId = this.requireAgent(actor);
    if (!WORK_STATES.includes(input.state)) throw badRequest("invalid state");
    return this.withTx(async (ctx) => {
      await this.requireCurrentGeneration(agentId, input.generation, ctx.c);
      const prev = await this.getAgentRow(agentId, ctx.c);
      const detail = input.detail ? redactLine(input.detail).slice(0, 300) : null;
      await ctx.c.query(
        "UPDATE agents SET last_heartbeat_at=now(), work_state=$2, work_detail=$3, work_updated_at = CASE WHEN work_state <> $2 OR work_detail IS DISTINCT FROM $3 THEN now() ELSE work_updated_at END WHERE id=$1",
        [agentId, input.state, detail],
      );
      if (prev.work_state !== input.state || prev.work_detail !== detail || !prev.last_heartbeat_at) {
        await this.emit(ctx, { type: "work.state", agentId, payload: { state: input.state, detail } });
      }
      return { acceptingWork: prev.accepting_work && prev.lifecycle_state !== "retired" };
    });
  }

  /**
   * Lease the next task. Returns the agent's already-running run for this
   * generation first (harness restarted its loop), so a retry never starts a
   * second worker for the same attempt.
   */
  async claim(actor: Actor, generation: number) {
    const agentId = this.requireAgent(actor);
    return this.withTx(async (ctx) => {
      const rt = await this.requireCurrentGeneration(agentId, generation, ctx.c);
      if (this.runState !== "running") return null; // stopping: runs in flight finish, nothing new starts
      const agent = await this.getAgentRow(agentId, ctx.c);
      const existing = await ctx.c.query(
        "SELECT * FROM task_runs WHERE agent_id=$1 AND status='running' AND runtime_generation=$2 LIMIT 1",
        [agentId, generation],
      );
      if (existing.rows[0]) {
        const run = existing.rows[0];
        const config = run.config_snapshot ?? { ...await this.runConfig(agent, ctx.c), credentialId: agent.credential_id };
        if (!run.config_snapshot) await ctx.c.query("UPDATE task_runs SET config_snapshot=$2 WHERE id=$1", [run.id, JSON.stringify(config)]);
        return { run: this.presentRun(run), task: this.presentTask(await this.getTaskRow(run.task_id, ctx.c)), resumed: true, config };
      }
      // Finish an existing run, then let the controller upgrade before taking more work.
      if (rt.pending_preset_id && this.config.runtimeCatalog.some((p) => p.id === rt.pending_preset_id && p.harness === "claude")) return null;
      if (!agent.accepting_work || agent.lifecycle_state === "retired") return null;
      if (rt.applied_secret_rev && rt.applied_secret_rev !== await this.desiredSecretRev(agent, ctx.c)) return null;
      const { rows } = await ctx.c.query<TaskRow>(
        // A campaign's tasks wait while it is manual (or stopped, or over); only a running auto campaign lets them start.
        `SELECT * FROM tasks t WHERE assignee_agent_id=$1 AND status='assigned'
           AND (campaign_id IS NULL OR EXISTS (SELECT 1 FROM campaigns c WHERE c.id = t.campaign_id AND c.mode = 'auto' AND c.status = 'active'))
         ORDER BY created_at LIMIT 1 FOR UPDATE OF t SKIP LOCKED`,
        [agentId],
      );
      const t = rows[0];
      if (!t) return null;
      const config = { ...await this.runConfig(agent, ctx.c), credentialId: agent.credential_id };
      const runId = newId("r");
      const ins = await ctx.c.query(
        `INSERT INTO task_runs(id, task_id, agent_id, attempt, idempotency_key, runtime_generation, lease_expires_at, status,config_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7), 'running',$8)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
        [runId, t.id, agentId, t.attempt, `${t.id}:${t.attempt}`, generation, LEASE_SECONDS, JSON.stringify(config)],
      );
      if (!ins.rows[0]) {
        // This attempt already had a run (e.g. it finished but the status update raced). Never start it twice.
        await ctx.c.query("UPDATE tasks SET attempt = attempt + 1 WHERE id=$1", [t.id]);
        return null;
      }
      await this.setTaskStatus(ctx, t, "in_progress", null);
      await this.emit(ctx, { type: "run.started", agentId, taskId: t.id, runId, payload: { attempt: t.attempt, generation, title: t.title } });
      return { run: this.presentRun(ins.rows[0]), task: this.presentTask(t), resumed: false, config };
    });
  }

  presentRun(r: Record<string, any>) {
    return {
      id: r.id,
      taskId: r.task_id,
      agentId: r.agent_id,
      attempt: r.attempt,
      idempotencyKey: r.idempotency_key,
      runtimeGeneration: r.runtime_generation,
      leaseExpiresAt: r.lease_expires_at,
      status: r.status,
    };
  }

  private async requireOwnRun(agentId: string, runId: string, generation: number, q: Queryable, lock = false) {
    const { rows } = await q.query(`SELECT * FROM task_runs WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`, [runId]);
    const run = rows[0];
    if (!run || run.agent_id !== agentId) throw notFound("run");
    if (run.runtime_generation !== generation) throw conflict("stale_runtime", "run belongs to a replaced runtime generation");
    if (run.status !== "running") throw conflict("run_closed", `run is ${run.status}`);
    return run;
  }

  async runHeartbeat(actor: Actor, runId: string, generation: number) {
    const agentId = this.requireAgent(actor);
    const { rows } = await this.db.query(
      `UPDATE task_runs SET lease_expires_at = now() + make_interval(secs => $4)
       WHERE id=$1 AND agent_id=$2 AND runtime_generation=$3 AND status='running' RETURNING lease_expires_at`,
      [runId, agentId, generation, LEASE_SECONDS],
    );
    if (!rows[0]) throw conflict("run_closed", "run is not running for this runtime");
    return { leaseExpiresAt: rows[0].lease_expires_at };
  }

  async runLogs(actor: Actor, runId: string, generation: number, lines: Array<{ stream: string; line: string }>) {
    const agentId = this.requireAgent(actor);
    await this.requireOwnRun(agentId, runId, generation, this.db);
    const batch = lines.slice(0, 500);
    if (!batch.length) return;
    const values: unknown[] = [];
    const tuples = batch.map((l) => {
      values.push(agentId, runId, l.stream === "stderr" ? "stderr" : l.stream === "agent" ? "agent" : "stdout", redactLine(String(l.line)).slice(0, 4000));
      const n = values.length;
      return `($${n - 3},$${n - 2},$${n - 1},$${n})`;
    });
    await this.db.query(`INSERT INTO agent_logs(agent_id, run_id, stream, line) VALUES ${tuples.join(",")}`, values);
    // What the agent writes between its commands, so people can follow along like a chat.
    // Commands show as "$ …", shortened; everything else is the agent talking.
    const said = batch
      .filter((l) => l.stream === "agent")
      .map((l) => redactLine(String(l.line)).trim())
      .filter(Boolean)
      .map((l) => (l.startsWith("$ ") ? (l.length > 90 ? `${l.slice(0, 90)}…` : l) : l))
      .join("\n");
    if (said) {
      const run = (await this.db.query<{ task_id: string }>("SELECT task_id FROM task_runs WHERE id=$1", [runId])).rows[0];
      await this.withTx((ctx) => this.emit(ctx, { type: "agent.said", agentId, taskId: run?.task_id ?? null, runId, payload: { text: said.slice(0, 500) } }));
    }
  }

  async uploadArtifact(actor: Actor, runId: string, generation: number, input: { name: string; contentType: string; content: Buffer }) {
    const agentId = this.requireAgent(actor);
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(input.name)) throw badRequest("invalid artifact name");
    if (input.content.length > 2 * 1024 * 1024) throw badRequest("artifact too large (2 MiB max)");
    return this.withTx(async (ctx) => {
      const run = await this.requireOwnRun(agentId, runId, generation, ctx.c);
      const id = newId("f");
      const hash = sha256(input.content);
      const { rows } = await ctx.c.query(
        `INSERT INTO artifacts(id, task_id, run_id, agent_id, name, content_type, content, sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (run_id, name) DO UPDATE SET content=EXCLUDED.content, sha256=EXCLUDED.sha256, content_type=EXCLUDED.content_type
         RETURNING id`,
        [id, run.task_id, runId, agentId, input.name, input.contentType.slice(0, 100), input.content, hash],
      );
      await this.emit(ctx, { type: "artifact.created", agentId, taskId: run.task_id, runId, payload: { name: input.name, sha256: hash, size: input.content.length } });
      return { id: rows[0].id, sha256: hash };
    });
  }

  async getArtifact(actor: Actor, id: string) {
    const { rows } = await this.db.query("SELECT * FROM artifacts WHERE id=$1", [id]);
    const a = rows[0];
    if (!a) throw notFound("artifact");
    await this.requireTaskView(actor, a.task_id);
    return { name: a.name as string, contentType: a.content_type as string, content: a.content as Buffer, sha256: a.sha256 as string };
  }

  async runEvent(actor: Actor, runId: string, generation: number, input: { type: string; message?: string; data?: Record<string, unknown> }) {
    const agentId = this.requireAgent(actor);
    if (!/^[a-z][a-z0-9_.]{0,40}$/.test(input.type)) throw badRequest("invalid event type");
    await this.withTx(async (ctx) => {
      const run = await this.requireOwnRun(agentId, runId, generation, ctx.c);
      await this.emit(ctx, {
        type: `harness.${input.type}`,
        agentId,
        taskId: run.task_id,
        runId,
        payload: { message: input.message?.slice(0, 500), ...(input.data ?? {}) },
      });
    });
  }

  // ---- waiting on people: an agent asks the person who gave it the work (or needs an approval), stops
  // with BLOCKED, and the task resumes once they reply — or, for a question, at its deadline, when the
  // agent is told to decide for itself.

  /** Pending proposals that hold this task, and whether one was settled since the run began. */
  private async ownerAlreadyReplied(q: Queryable, taskId: string, since: Date): Promise<boolean> {
    const { rows } = await q.query<{ pending: string; settled: string }>(
      `SELECT count(*) FILTER (WHERE status='pending') AS pending, count(*) FILTER (WHERE status<>'pending' AND updated_at >= $2) AS settled
         FROM proposals WHERE org_id=$3 AND payload->>'taskId' = $1 AND kind <> 'task_result'`,
      [taskId, since, this.orgId],
    );
    return Number(rows[0]!.pending) === 0 && Number(rows[0]!.settled) > 0;
  }

  async askOwner(actor: Actor, taskId: string, input: { question: string; options?: string[]; timeoutMinutes?: number; fallback?: string; computer?: string }) {
    const agentId = this.requireAgent(actor);
    return this.withTx(async (ctx) => {
      const t = await this.getTaskRow(taskId, ctx.c, true);
      if (t.assignee_agent_id !== agentId || !["in_progress", "assigned"].includes(t.status)) throw conflict("bad_state", "you can only ask about a task you are working on");
      const minutes = Math.min(1440, Math.max(5, input.timeoutMinutes ?? 30));
      const deadline = new Date(Date.now() + minutes * 60_000).toISOString();
      const p = await openProposal(ctx.c, {
        orgId: this.orgId, kind: "question", title: input.question.slice(0, 300), proposer: actorRef(actor),
        subject: { type: "task", id: t.id },
        payload: { taskId: t.id, taskTitle: t.title, question: input.question, options: input.options ?? [], deadline, fallback: input.fallback ?? null, ...(input.computer ? { computer: input.computer } : {}) },
        source: { type: "question", id: newId("q") },
        // The person who gave the work answers (the owner always can).
        approvers: { kind: "task_reviewer", createdBy: t.created_by },
        evaluation: [{ rule: "question", verdict: "require_approval", reason: "the agent needs an answer to go on" }],
      });
      await this.emit(ctx, { type: "task.question", agentId, taskId: t.id, payload: { title: t.title, question: input.question.slice(0, 300), deadline, proposalId: p.id } });
      return { questionId: p.id, deadline };
    });
  }

  /** A person answers (or the deadline passes): the answer goes into the task and it resumes. */
  async answerQuestion(actor: Actor | null, proposalId: string, answer: string, declined = false) {
    const p = (await this.db.query<{ id: string; status: string; payload: Record<string, any>; approvers: { kind: string; createdBy?: string }; source_type: string; source_id: string }>(
      "SELECT * FROM proposals WHERE id=$1 AND org_id=$2 AND kind='question'", [proposalId, this.orgId])).rows[0];
    if (!p) throw notFound("question");
    if (p.status !== "pending") throw conflict("not_pending", "the question was already answered");
    if (actor && !isOwner(actor) && actorRef(actor) !== p.approvers.createdBy) throw deny("only the person who gave this work (or the owner) answers it");
    const by = actor ? actorRef(actor) : "system:deadline";
    const text = declined ? "The owner chose not to answer: decide yourself and say which assumption you made." : answer.trim();
    await recordProposal(this.db, { type: p.source_type, id: p.source_id }, {
      status: "applied", decision: { by, verdict: declined ? "reject" : "approve", ...(text ? { note: text.slice(0, 2000) } : {}) }, receipt: { answer: text.slice(0, 2000) },
    });
    await this.resumeFromOwner(String(p.payload.taskId), `Question: ${p.payload.question}\nAnswer${actor ? "" : " (no reply before the deadline)"}: ${text}`);
  }

  /** Questions past their deadline are settled with the agent's own fallback, or leave the choice to it. */
  async expireQuestions() {
    const { rows } = await this.db.query<{ id: string; payload: Record<string, any> }>(
      "SELECT id, payload FROM proposals WHERE org_id=$1 AND kind='question' AND status='pending' AND (payload->>'deadline')::timestamptz < now()",
      [this.orgId],
    );
    for (const r of rows) {
      const fallback = r.payload.fallback ? `Go with your stated default: ${r.payload.fallback}` : "Nobody answered in time: decide yourself, and say which assumption you made.";
      await this.answerQuestion(null, r.id, fallback).catch((err) => console.warn(`[question ${r.id}]`, (err as Error).message));
    }
  }

  /** Note what the owner said on the task; a task stopped to wait goes back to work once nothing else holds it. */
  async resumeFromOwner(taskId: string, note: string) {
    await this.withTx(async (ctx) => {
      const t = await this.getTaskRow(taskId, ctx.c, true);
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      await ctx.c.query("UPDATE tasks SET description = description || $2, updated_at=now() WHERE id=$1", [t.id, `\n\n--- From the owner (${stamp} UTC) ---\n${note}`.slice(0, 6000)]);
      if (t.status !== "blocked") return; // still running: it reads the note when it stops, or right away if it asks again
      const pending = await ctx.c.query("SELECT 1 FROM proposals WHERE org_id=$2 AND status='pending' AND payload->>'taskId' = $1 AND kind <> 'task_result' LIMIT 1", [t.id, this.orgId]);
      if (!pending.rows[0]) {
        await this.nextAttempt(ctx, t.id);
        await this.setTaskStatus(ctx, t, "assigned", "the owner replied");
      }
    });
  }

  /** Going back to work after waiting is a new attempt (a run per attempt), and does not use up the retries. */
  private async nextAttempt(ctx: Ctx, taskId: string) {
    await ctx.c.query("UPDATE tasks SET attempt = attempt + 1, max_attempts = GREATEST(max_attempts, attempt + 1) WHERE id=$1", [taskId]);
  }

  async completeRun(
    actor: Actor,
    runId: string,
    generation: number,
    input: { outcome: "succeeded" | "failed" | "blocked"; summary?: string; usage?: Record<string, unknown> },
  ) {
    const agentId = this.requireAgent(actor);
    return this.withTx(async (ctx) => {
      const run = await this.requireOwnRun(agentId, runId, generation, ctx.c, true);
      const summary = input.summary ? redactLine(input.summary).slice(0, 4000) : null;
      // It asked a question and stopped without saying BLOCKED: it still waits for the answer, it is not done.
      const asking = input.outcome === "succeeded" &&
        (await ctx.c.query("SELECT 1 FROM proposals WHERE org_id=$2 AND kind='question' AND status='pending' AND payload->>'taskId'=$1 LIMIT 1", [run.task_id, this.orgId])).rows.length > 0;
      input = { ...input, outcome: asking ? "blocked" : input.outcome };
      await ctx.c.query("UPDATE task_runs SET status=$2, finished_at=now(), summary=$3, usage=$4 WHERE id=$1", [
        runId,
        input.outcome,
        summary,
        input.usage ? JSON.stringify(sanitize(input.usage)) : null,
      ]);
      const t = await this.getTaskRow(run.task_id, ctx.c, true);
      if (t.status === "in_progress" && t.assignee_agent_id === agentId) {
        if (input.outcome === "succeeded") await this.setTaskStatus(ctx, t, t.requires_review ? "review" : "done", null, summary);
        else if (input.outcome === "blocked" && (await this.ownerAlreadyReplied(ctx.c, t.id, run.started_at))) {
          // It stopped to wait, but the answer (or approval) came in while it was still finishing: go on.
          await this.nextAttempt(ctx, t.id);
          await this.setTaskStatus(ctx, t, "assigned", "the owner already replied");
        } else await this.setTaskStatus(ctx, t, input.outcome, summary ?? input.outcome, summary);
      }
      await this.emit(ctx, { type: "run.finished", agentId, taskId: t.id, runId, payload: { outcome: input.outcome, summary, usage: input.usage ?? null } });
      return { taskStatus: t.status };
    });
  }

  /**
   * Pausing ends once no run is left, or when the grace period is over: then runs still going are cut
   * and their tasks wait in the queue, without using up a retry. Then nothing of the org runs.
   */
  async settlePause(graceMs: number) {
    // The grace period is measured on the database's clock, the one paused_at was written with.
    const { rows } = await this.db.query<{ over: boolean; running: string }>(
      `SELECT now() - paused_at >= make_interval(secs => $2::float8 / 1000) AS over,
              (SELECT count(*) FROM task_runs r JOIN agents a ON a.id = r.agent_id WHERE a.org_id = $1 AND r.status = 'running') AS running
         FROM organizations WHERE id = $1 AND paused_at IS NOT NULL AND stopped_at IS NULL`,
      [this.orgId, graceMs],
    );
    const o = rows[0];
    if (!o) return;
    if (Number(o.running) > 0) {
      if (!o.over) return;
      await this.releaseRunsForPause();
    }
    await this.db.query("UPDATE organizations SET stopped_at = now() WHERE id = $1 AND paused_at IS NOT NULL AND stopped_at IS NULL", [this.orgId]);
  }

  private async releaseRunsForPause() {
    await this.withTx(async (ctx) => {
      const { rows } = await ctx.c.query<{ task_id: string }>(
        `UPDATE task_runs SET status='lost', finished_at=now(), summary='organization paused: cut at the end of the grace period'
          WHERE status='running' AND agent_id IN (SELECT id FROM agents WHERE org_id=$1) RETURNING task_id`,
        [this.orgId],
      );
      for (const r of rows) {
        const t = await this.getTaskRow(r.task_id, ctx.c, true);
        if (t.status !== "in_progress") continue;
        // A new run needs a new attempt; the pause gives it for free.
        await ctx.c.query("UPDATE tasks SET attempt = attempt + 1, max_attempts = max_attempts + 1 WHERE id=$1", [t.id]);
        await this.setTaskStatus(ctx, t, "assigned", "organization paused; it goes on when the organization plays again");
      }
    });
  }

  /** Expired leases: the worker is presumed gone. Mark lost and requeue (bounded). */
  async sweepLeases(): Promise<number> {
    return this.withTx(async (ctx) => {
      const { rows } = await ctx.c.query<{ id: string; task_id: string }>(
        `UPDATE task_runs SET status='lost', finished_at=now(), summary='lease expired'
          WHERE status='running' AND lease_expires_at < now() AND agent_id IN (SELECT id FROM agents WHERE org_id=$1) RETURNING id, task_id`,
        [this.orgId],
      );
      for (const r of rows) await this.requeueAfterLostRun(ctx, r.task_id, r.id, "lease expired");
      return rows.length;
    });
  }

  // ---------------------------------------------------------------- runtime observations (controller)

  async recordObservation(agentId: string, obs: { state: string; detail: string | null; workloadRef: string | null; generation: number; ready: boolean }) {
    await this.withTx(async (ctx) => {
      const rt = await this.getRuntimeRow(agentId, ctx.c);
      if (rt.generation !== obs.generation) return; // stale observation
      const readyGen = obs.ready ? obs.generation : rt.ready_generation === obs.generation ? null : rt.ready_generation;
      const changed = rt.observed_state !== obs.state || rt.observed_detail !== obs.detail || rt.workload_ref !== obs.workloadRef || rt.ready_generation !== readyGen;
      await ctx.c.query(
        "UPDATE agent_runtimes SET observed_state=$2, observed_detail=$3, workload_ref=$4, observed_at=now(), ready_generation=$5 WHERE agent_id=$1",
        [agentId, obs.state, obs.detail, obs.workloadRef, readyGen],
      );
      if (obs.ready) {
        const agent = await this.getAgentRow(agentId, ctx.c);
        if (agent.lifecycle_state === "provisioning") {
          await ctx.c.query("UPDATE agents SET lifecycle_state='active' WHERE id=$1", [agentId]);
          await this.emit(ctx, { type: "agent.active", agentId, payload: {} });
        }
      }
      if (changed) {
        await this.emit(ctx, {
          type: "runtime.state",
          agentId,
          payload: { state: obs.state, detail: obs.detail, generation: obs.generation, ready: obs.ready, workloadRef: obs.workloadRef },
        });
      }
    });
  }

  async controllerBumpGeneration(agentId: string, reason: string): Promise<number> {
    return this.withTx((ctx) => this.bumpGeneration(ctx, agentId, reason));
  }

  /** Apply a queued upgrade once; keep busy agents and unavailable presets pending. */
  async applyPendingRuntimeUpgrade(agentId: string): Promise<boolean> {
    return this.withTx(async (ctx) => {
      const rt = await this.getRuntimeRow(agentId, ctx.c, true);
      const target = this.config.runtimeCatalog.find((p) => p.id === rt.pending_preset_id && p.harness === "claude");
      if (!target || (await ctx.c.query("SELECT 1 FROM task_runs WHERE agent_id=$1 AND status='running'", [agentId])).rowCount) return false;
      await ctx.c.query(
        "UPDATE agent_runtimes SET preset_id=$2, pending_preset_id=NULL, observed_state='none', observed_detail=NULL, applied_secret_rev=NULL WHERE agent_id=$1",
        [agentId, target.id],
      );
      const reason = `runtime preset upgrade: ${rt.preset_id} -> ${target.id}`;
      await this.bumpGeneration(ctx, agentId, reason);
      await this.audit(ctx.c, "system:migration", "runtime.upgrade", agentId, true, reason);
      return true;
    });
  }

  // ---------------------------------------------------------------- office snapshot & events

  async snapshot(actor: Actor) {
    // Event sequence numbers are global; the cursor is the newest one this org has.
    const { rows } = await this.db.query<{ seq: string | null }>("SELECT max(seq) AS seq FROM agent_events WHERE org_id=$1", [this.orgId]);
    const cursor = Number(rows[0]?.seq ?? 0);
    const [agents, tasks, teams, recent] = await Promise.all([this.listAgents(actor), this.listTasks(actor), this.listTeams(actor), this.recentActivity(actor)]);
    return {
      cursor,
      organization: this.config.organization,
      me: actor,
      departments: this.config.departments,
      teams,
      recent,
      projects: this.config.projects,
      kernel: this.config.kernel,
      leadAgentId: await this.leadAgentId(),
      world: this.config.world ?? null,
      objectStates: await this.objectStates(),
      agents,
      tasks,
      serverTime: new Date().toISOString(),
    };
  }

  async visibleFilter(actor: Actor): Promise<(e: AgentEventRow) => boolean> {
    if (isOwner(actor)) return () => true;
    if (actor.kind === "human" && !(await this.userActive(actor.id))) return () => false;
    const policy = await this.loadPolicy();
    // Organization-level events (structure changed) concern every member; agent events need org.view.
    return (e) => (e.type.startsWith("org.") && !e.agentId) || (!!e.agentId && authorize(actor, "org.view", { agentId: e.agentId }, policy).allowed);
  }

  /** The latest notable events the caller may see (newest first), so the activity list is not empty on load. */
  async recentActivity(actor: Actor, limit = 40): Promise<AgentEventRow[]> {
    const { rows } = await this.db.query<{ seq: string }>(
      `SELECT max(seq) - 2000 AS seq FROM agent_events WHERE org_id=$1`,
      [this.orgId],
    );
    const notable = /^(agent\.(spawned|configured|team|retired)|task\.(created|status)|run\.(started|finished|lost)|artifact\.created|grant\.|credential\.(created|revoked)|user\.created|runtime\.generation)/;
    const events = (await this.eventsAfter(actor, Math.max(0, Number(rows[0]?.seq ?? 0)), 2000)).filter((e) => notable.test(e.type));
    return events.slice(-limit).reverse();
  }

  async eventsAfter(actor: Actor, cursor: number, limit = 1000): Promise<AgentEventRow[]> {
    const { rows } = await this.db.query(
      "SELECT seq, at, agent_id, task_id, run_id, type, payload FROM agent_events WHERE org_id = $3 AND seq > $1 ORDER BY seq LIMIT $2",
      [cursor, limit, this.orgId],
    );
    const visible = await this.visibleFilter(actor);
    return rows
      .map((r) => ({
        orgId: this.orgId,
        seq: Number(r.seq),
        at: r.at.toISOString(),
        agentId: r.agent_id,
        taskId: r.task_id,
        runId: r.run_id,
        type: r.type,
        payload: r.payload,
      }))
      .filter(visible);
  }

  async listAudit(actor: Actor, after: number) {
    await this.require(actor, "audit.view", {});
    const { rows } = await this.db.query("SELECT * FROM audit_events WHERE org_id = $2 AND id > $1 ORDER BY id DESC LIMIT 300", [after, this.orgId]);
    return rows.map((r) => ({ ...r, id: Number(r.id), policy_revision: r.policy_revision === null ? null : Number(r.policy_revision) }));
  }

  catalog(actor: Actor) {
    void actor;
    return {
      templates: this.config.agentTemplates,
      presets: this.config.runtimeCatalog.filter((p) => p.harness !== "browser").map((p) => ({ id: p.id, version: p.version, harness: p.harness, image: p.image, resources: p.resources, member: p.member, placement: p.placement, model: p.model ?? null })),
      departments: this.config.departments,
      projects: this.config.projects,
      providers: PROVIDER_INFO,
    };
  }

  // ---------------------------------------------------------------- people

  userActive(id: string, q: Queryable = this.db): Promise<boolean> {
    return this.kernel.identity.userActive(id, q);
  }

  /** Who am I and what may I do at the organization level: drives which controls the UI shows. */
  async me(actor: Actor) {
    const policy = await this.loadPolicy();
    const user =
      actor.kind === "human"
        ? (await this.db.query<UserRow>(`${MEMBERS_SQL} AND u.id = $2`, [this.orgId, actor.id])).rows.map((u) => this.presentUser(u, []))[0] ?? null
        : null;
    const can: Partial<Record<Action, boolean>> = {};
    for (const a of ORG_ACTIONS) can[a] = authorize(actor, a, {}, policy).allowed;
    const agents = (await this.db.query<{ id: string }>("SELECT id FROM agents WHERE org_id=$1 AND lifecycle_state <> 'retired' ORDER BY id", [this.orgId])).rows;
    return {
      organization: this.config.organization,
      actor,
      user,
      can,
      /** Agents the caller may give a task to, and those it may also run shell work on. */
      taskTargets: agents.filter((a) => authorize(actor, "task.create", { agentId: a.id }, policy).allowed).map((a) => a.id),
      execTargets: agents.filter((a) => authorize(actor, "runtime.exec", { agentId: a.id }, policy).allowed).map((a) => a.id),
      configureTargets: agents.filter((a) => authorize(actor, "agent.configure", { agentId: a.id }, policy).allowed).map((a) => a.id),
    };
  }

  private presentUser(u: UserRow, grants: Grant[]) {
    return {
      id: u.id,
      displayName: u.display_name,
      roleId: u.role_id,
      owner: u.is_owner,
      disabledAt: u.disabled_at?.toISOString() ?? null,
      createdBy: u.created_by,
      createdAt: u.created_at.toISOString(),
      permissions: grants.map((g) => ({ id: g.id, action: g.action, scope: g.scope, constraints: g.constraints, issuer: g.issuer })),
    };
  }

  roles() {
    return Object.entries(this.config.humanRoles).map(([id, r]) => ({
      id,
      name: r.name,
      permissions: r.permissions.map((c) => ({ action: c.action, scope: c.scope, constraints: capConstraints(c) })),
    }));
  }

  async listUsers(actor: Actor) {
    const policy = await this.require(actor, "user.manage", {});
    const { rows } = await this.db.query<UserRow>(`${MEMBERS_SQL} ORDER BY m.is_owner DESC, m.created_at`, [this.orgId]);
    return rows.map((u) => this.presentUser(u, policy.grants.filter((g) => g.principalId === `user:${u.id}` && isGrantEffective(g, policy))));
  }

  private async getUserRow(id: string, q: Queryable = this.db): Promise<UserRow> {
    const { rows } = await q.query<UserRow>(`${MEMBERS_SQL} AND u.id = $2`, [this.orgId, id]);
    if (!rows[0]) throw notFound("user");
    return rows[0];
  }

  /** Nobody edits the owner, and nobody edits themselves (no granting yourself more). */
  private async requireUserManage(actor: Actor, target: UserRow, ctx: Ctx, what: string, detail?: Record<string, unknown>): Promise<LoadedPolicy> {
    const policy = await this.require(actor, "user.manage", {}, { q: ctx.c, auditAs: what, detail: { user: target.id, ...detail } });
    if (target.is_owner) throw deny(`${what} denied: the owner cannot be changed`);
    if (actor.kind === "human" && actor.id === target.id) throw deny(`${what} denied: you cannot change your own access`);
    return policy;
  }

  private validateUserGrant(p: { action: Action; scope: Scope; constraints: GrantConstraints }) {
    if (!USER_SCOPE_KINDS.includes(p.scope.kind)) throw badRequest("a person's permission scope must be org, departments, agents or projects");
    if (ORG_ACTIONS.includes(p.action) && p.scope.kind !== "org") throw badRequest(`${p.action} needs scope org`);
    if (p.action === "agent.spawn" && !p.constraints.templates?.length) throw badRequest("agent.spawn needs a templates list");
    if (p.action.startsWith("code.") && !p.constraints.repos?.length) throw badRequest(`${p.action} needs a repos list`);
    if (p.scope.kind === "departments" && !p.scope.ids.every((d) => this.config.departments.some((x) => x.id === d))) throw badRequest("unknown department");
    if (p.scope.kind === "projects" && !p.scope.ids.every((d) => this.config.projects.some((x) => x.id === d))) throw badRequest("unknown project");
    for (const t of p.constraints.templates ?? []) if (!this.config.agentTemplates.some((x) => x.id === t)) throw badRequest(`unknown template ${t}`);
  }

  /** Inside a transaction that already passed requireUserManage. */
  private async insertUserGrant(ctx: Ctx, actor: Actor, policy: LoadedPolicy, userId: string, p: { action: Action; scope: Scope; constraints: GrantConstraints }) {
    this.validateUserGrant(p);
    const d = canGrantToUser(actor, p, policy);
    if (!d.allowed) {
      await this.audit(this.db, actor, "user.grant", userId, false, d.reason, { ...p }, policy.revision);
      throw deny(`user.grant denied: ${d.reason}`);
    }
    const id = newId("g");
    await ctx.c.query(
      `INSERT INTO grants(id, principal_id, action, scope, constraints, delegable, issuer, parent_grant_id, expires_at, org_id)
       VALUES ($1,$2,$3,$4,$5,false,$6,NULL,NULL,$7)`,
      [id, `user:${userId}`, p.action, JSON.stringify(p.scope), JSON.stringify(p.constraints), isOwner(actor) ? "owner" : principalOf(actor), this.orgId],
    );
    await this.audit(ctx.c, actor, "user.grant", userId, true, d.reason, { grantId: id, ...p }, policy.revision);
    return id;
  }

  /** Copy a role's permissions onto a person; with replace, their current permissions go first. */
  private async applyRole(ctx: Ctx, actor: Actor, policy: LoadedPolicy, userId: string, roleId: string, replace: boolean) {
    const role = this.config.humanRoles[roleId];
    if (!role) throw badRequest(`unknown role ${roleId}`);
    if (replace) {
      await ctx.c.query("UPDATE grants SET revoked_at=now(), revision=revision+1 WHERE org_id=$1 AND principal_id=$2 AND revoked_at IS NULL", [this.orgId, `user:${userId}`]);
    }
    for (const c of role.permissions) {
      await this.insertUserGrant(ctx, actor, policy, userId, { action: c.action, scope: c.scope, constraints: capConstraints(c) });
    }
    await ctx.c.query("UPDATE org_members SET role_id=$3 WHERE org_id=$1 AND user_id=$2", [this.orgId, userId, roleId]);
  }

  /** Invite a person. The token is returned once; only its hash is stored. */
  async createUser(actor: Actor, input: { displayName: string; roleId?: string | null }) {
    return this.withTx(async (ctx) => {
      const policy = await this.require(actor, "user.manage", {}, { q: ctx.c, auditAs: "user.create", detail: input });
      const id = newId("u");
      await ctx.c.query("INSERT INTO users(id, display_name, created_by) VALUES ($1,$2,$3)", [id, input.displayName, actorRef(actor)]);
      await ctx.c.query("INSERT INTO org_members(org_id, user_id, created_by) VALUES ($1,$2,$3)", [this.orgId, id, actorRef(actor)]);
      if (input.roleId) await this.applyRole(ctx, actor, policy, id, input.roleId, false);
      const token = await this.issueToken(ctx.c, "human", id, "invite", true);
      await this.bumpRevision(ctx.c);
      await this.emit(ctx, { type: "user.created", payload: { userId: id, displayName: input.displayName, roleId: input.roleId ?? null } });
      return { user: await this.presentUserById(id, ctx.c), token };
    });
  }

  private async presentUserById(id: string, q: Queryable) {
    const policy = await this.loadPolicy(q);
    return this.presentUser(await this.getUserRow(id, q), policy.grants.filter((g) => g.principalId === `user:${id}` && isGrantEffective(g, policy)));
  }

  async updateUser(actor: Actor, id: string, input: { displayName?: string; disabled?: boolean; roleId?: string }) {
    return this.withTx(async (ctx) => {
      const u = await this.getUserRow(id, ctx.c);
      const policy = await this.requireUserManage(actor, u, ctx, "user.update", input);
      if (input.displayName) {
        await this.requireOnlyHere(ctx.c, id, "rename");
        await ctx.c.query("UPDATE users SET display_name=$2 WHERE id=$1", [id, input.displayName]);
      }
      if (input.disabled !== undefined) {
        // Disabling here only closes this organization; the account and other memberships are untouched.
        await ctx.c.query(
          "UPDATE org_members SET disabled_at = CASE WHEN $3 THEN COALESCE(disabled_at, now()) ELSE NULL END WHERE org_id=$1 AND user_id=$2",
          [this.orgId, id, input.disabled],
        );
      }
      if (input.roleId) await this.applyRole(ctx, actor, policy, id, input.roleId, true);
      await this.bumpRevision(ctx.c);
      await this.emit(ctx, { type: "user.updated", payload: { userId: id } });
      return this.presentUserById(id, ctx.c);
    });
  }

  /** New token for a person; the old ones stop working at once. */
  async resetUserToken(actor: Actor, id: string) {
    return this.withTx(async (ctx) => {
      await this.requireUserManage(actor, await this.getUserRow(id, ctx.c), ctx, "user.token");
      await this.requireOnlyHere(ctx.c, id, "issue a new token for");
      return { token: await this.issueToken(ctx.c, "human", id, "reset", true) };
    });
  }

  async grantUser(actor: Actor, id: string, input: { action: Action; scope: Scope; constraints?: GrantConstraints }) {
    return this.withTx(async (ctx) => {
      const policy = await this.requireUserManage(actor, await this.getUserRow(id, ctx.c), ctx, "user.grant");
      const grantId = await this.insertUserGrant(ctx, actor, policy, id, { action: input.action, scope: input.scope, constraints: input.constraints ?? {} });
      await this.bumpRevision(ctx.c);
      await this.emit(ctx, { type: "user.updated", payload: { userId: id } });
      return { id: grantId };
    });
  }

  async revokeUserGrant(actor: Actor, id: string, grantId: string) {
    await this.withTx(async (ctx) => {
      await this.requireUserManage(actor, await this.getUserRow(id, ctx.c), ctx, "user.revoke", { grantId });
      const r = await ctx.c.query(
        "UPDATE grants SET revoked_at=now(), revision=revision+1 WHERE id=$1 AND principal_id=$2 AND org_id=$3 AND revoked_at IS NULL",
        [grantId, `user:${id}`, this.orgId],
      );
      if (!r.rowCount) throw notFound("permission");
      await this.bumpRevision(ctx.c);
      await this.emit(ctx, { type: "user.updated", payload: { userId: id } });
    });
  }

  /**
   * The account is shared across organizations: one org's user managers may only
   * change it (name, token) when the person belongs to no other organization.
   * Otherwise an admin of org A could take over someone's access to org B.
   */
  private async requireOnlyHere(q: Queryable, userId: string, what: string) {
    const { rows } = await q.query("SELECT 1 FROM org_members WHERE user_id=$1 AND org_id <> $2 LIMIT 1", [userId, this.orgId]);
    if (rows[0]) throw deny(`cannot ${what} a person who also belongs to another organization; ask the instance admin`);
  }

  /** Add an existing account to this organization, with no permissions yet. */
  async addMember(actor: Actor, userId: string) {
    return this.withTx(async (ctx) => {
      await this.require(actor, "user.manage", {}, { q: ctx.c, auditAs: "user.add", detail: { user: userId } });
      const { rows } = await ctx.c.query("SELECT 1 FROM users WHERE id=$1 AND disabled_at IS NULL", [userId]);
      if (!rows[0]) throw notFound("user");
      await ctx.c.query("INSERT INTO org_members(org_id, user_id, created_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [this.orgId, userId, actorRef(actor)]);
      await this.emit(ctx, { type: "user.updated", payload: { userId } });
      return this.presentUserById(userId, ctx.c);
    });
  }

  // ---------------------------------------------------------------- terminal sessions

  async openTerminal(actor: Actor, agentId: string) {
    return this.withTx(async (ctx) => {
      await this.getAgentRow(agentId, ctx.c);
      await this.require(actor, "runtime.exec", { agentId }, { q: ctx.c, auditAs: "terminal.open" });
      const rt = await this.getRuntimeRow(agentId, ctx.c);
      if (rt.observed_state !== "running" || rt.ready_generation !== rt.generation || !rt.workload_ref) {
        throw conflict("runtime_not_ready", "runtime is not running; start it before opening a terminal");
      }
      const id = newId("ts");
      const ticket = newSecret();
      await ctx.c.query(
        `INSERT INTO terminal_sessions(id, actor, agent_id, generation, ticket_hash, ticket_expires_at, org_id)
         VALUES ($1,$2,$3,$4,$5, now() + make_interval(secs => $6), $7)`,
        [id, actorRef(actor), agentId, rt.generation, sha256(ticket), TICKET_TTL_MS / 1000, this.orgId],
      );
      await this.emit(ctx, { type: "terminal.opened", agentId, payload: { sessionId: id, actor: actorRef(actor), generation: rt.generation } });
      return { sessionId: id, ticket, generation: rt.generation };
    });
  }

  /** One-time ticket → session target. Authorization and generation are re-checked at attach time. */
  async attachTerminal(sessionId: string, ticket: string) {
    // Redeeming burns the ticket even if the re-check below fails.
    const { rows } = await this.db.query(
      "UPDATE terminal_sessions SET ticket_hash=NULL, attached_at=now() WHERE id=$1 AND ticket_hash=$2 AND org_id=$3 AND ticket_expires_at > now() AND closed_at IS NULL RETURNING *",
      [sessionId, sha256(ticket), this.orgId],
    );
    const s = rows[0];
    if (!s) throw deny("invalid or expired terminal ticket");
    const actor = await this.parseActorRef(s.actor);
    const reason = await this.terminalStillAllowed(actor, s.agent_id, s.generation, this.db);
    if (reason) {
      await this.closeTerminal(sessionId, reason);
      throw deny(reason);
    }
    const rt = await this.getRuntimeRow(s.agent_id);
    await this.audit(this.db, actor, "terminal.attach", s.agent_id, true, "ticket redeemed", { sessionId, generation: s.generation });
    return { agentId: s.agent_id as string, namespace: rt.namespace, pod: rt.workload_ref!, generation: s.generation as number };
  }

  /** Rebuild an actor from its audit reference; a person's owner flag is read from their current membership. */
  parseActorRef(ref: string): Promise<Actor> {
    return this.kernel.identity.parseActorRef(ref);
  }

  private async terminalStillAllowed(actor: Actor, agentId: string, generation: number, q: Queryable): Promise<string | null> {
    if (actor.kind === "human" && !(await this.userActive(actor.id, q))) return "user is disabled";
    const policy = await this.loadPolicy(q);
    const d = authorize(actor, "runtime.exec", { agentId }, policy);
    if (!d.allowed) return `exec permission no longer held: ${d.reason}`;
    const rt = await this.getRuntimeRow(agentId, q);
    if (rt.generation !== generation) return "runtime was replaced";
    return null;
  }

  private async closeTerminalRow(q: Queryable, id: string, reason: string) {
    await q.query("UPDATE terminal_sessions SET closed_at=now(), close_reason=$2 WHERE id=$1 AND closed_at IS NULL", [id, reason]);
  }

  async closeTerminal(id: string, reason: string) {
    await this.withTx(async (ctx) => {
      const { rows } = await ctx.c.query("SELECT agent_id, actor FROM terminal_sessions WHERE id=$1 AND org_id=$2 AND closed_at IS NULL", [id, this.orgId]);
      if (!rows[0]) return;
      await this.closeTerminalRow(ctx.c, id, reason);
      await this.audit(ctx.c, rows[0].actor, "terminal.close", rows[0].agent_id, true, reason, { sessionId: id });
      await this.emit(ctx, { type: "terminal.closed", agentId: rows[0].agent_id, payload: { sessionId: id, reason } });
    });
  }

  /** Sessions that must be terminated after a policy/graph/runtime change. */
  async terminalsToRevoke(): Promise<Array<{ id: string; reason: string }>> {
    const { rows } = await this.db.query(
      "SELECT id, actor, agent_id, generation FROM terminal_sessions WHERE org_id=$1 AND closed_at IS NULL AND attached_at IS NOT NULL",
      [this.orgId],
    );
    const out: Array<{ id: string; reason: string }> = [];
    for (const s of rows) {
      const reason = await this.terminalStillAllowed(await this.parseActorRef(s.actor), s.agent_id, s.generation, this.db);
      if (reason) out.push({ id: s.id, reason });
    }
    return out;
  }
}

function capConstraints(c: { templates?: string[]; repos?: string[] }): GrantConstraints {
  return { ...(c.templates ? { templates: c.templates } : {}), ...(c.repos ? { repos: c.repos } : {}) };
}

/** LLM harness before script, shared before dedicated: a team runtime must run every member's work. */
function rank(p: RuntimePreset): number {
  return (p.harness === "claude" ? 0 : 2) + (p.placement === "shared" ? 0 : 1);
}

/** A declared runtime share ("250m", "256Mi") in millicores / MiB, bounded. */

function emptyConfig(): AgentConfig {
  return { credentialId: null, model: null, effort: null, instructions: "", maxTurns: 40, contextLimit: null };
}

export { ApiError };
