import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ACTIONS, type Action, type Scope } from "./types.ts";
import { checkWorld, worldSchema } from "./world.ts";

/**
 * Organization config. This file is authored by the human owner; the catalog and
 * template profiles in it are the *only* runtime shapes and permission bundles
 * agents can instantiate. Agents cannot edit it through the API.
 */

const scopeShorthand = z.enum(["self", "direct-reports", "descendants", "team", "department", "org"]);
const scopeSchema = z.union([
  scopeShorthand.transform((kind) => ({ kind }) as Scope),
  z.object({ agents: z.array(z.string()).min(1) }).transform((s) => ({ kind: "agents", ids: s.agents }) as Scope),
  z.object({ projects: z.array(z.string()).min(1) }).transform((s) => ({ kind: "projects", ids: s.projects }) as Scope),
  z.object({ departments: z.array(z.string()).min(1) }).transform((s) => ({ kind: "departments", ids: s.departments }) as Scope),
]);

/** Actions that are about the organization rather than an agent: org scope only. */
export const ORG_ACTIONS: readonly Action[] = ["credential.manage", "audit.view", "user.manage", "org.design"];
/** People sit outside the reporting tree, so only these scopes mean anything for them. */
export const USER_SCOPE_KINDS: readonly Scope["kind"][] = ["org", "departments", "agents", "projects"];

const capabilitySchema = z.object({
  action: z.enum(ACTIONS),
  scope: scopeSchema,
  templates: z.array(z.string()).optional(),
  repos: z.array(z.string()).optional(),
  delegable: z.boolean().default(false),
});
export type CapabilityConfig = z.infer<typeof capabilitySchema>;

const idSchema = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/, "lowercase dns-label id");

const runtimePresetSchema = z.object({
  id: idSchema,
  version: z.string().default("1"),
  /** Image reference; must also be allow-listed in the cluster admission policy. */
  image: z.string(),
  imagePullPolicy: z.enum(["Always", "IfNotPresent", "Never"]).default("IfNotPresent"),
  harness: z.enum(["script", "claude"]),
  /** Default model when an agent has none configured; must exist on the agent's credential. */
  model: z.string().optional(),
  /**
   * shared: any node. dedicated-node: at most one dedicated agent per node, only on
   * nodes labelled agentown.io/pool=dedicated (tainted so nothing else lands there).
   */
  placement: z.enum(["shared", "dedicated-node"]).default("shared"),
  workspace: z.object({ size: z.string().default("1Gi") }).prefault({}),
  /** Base share of a team runtime (supervisor); the team adds each member's declared share on top. */
  resources: z
    .object({ cpu: z.string().default("500m"), memory: z.string().default("512Mi") })
    .prefault({}),
  /** Default share a new member declares when the person adding it does not say. */
  member: z
    .object({ cpu: z.string().default("100m"), memory: z.string().default("192Mi") })
    .prefault({}),
});
export type RuntimePreset = z.infer<typeof runtimePresetSchema>;

const templateSchema = z.object({
  id: idSchema,
  jobRole: z.string(),
  runtimePreset: idSchema,
  policyProfile: z.string(),
});
export type AgentTemplate = z.infer<typeof templateSchema>;

const bootstrapAgentSchema = z.object({
  key: idSchema,
  displayName: z.string(),
  template: idSchema,
  department: idSchema,
  team: idSchema.optional(),
  reportsTo: idSchema.nullable().default(null),
});

/**
 * A team works inside one department and shares one runtime. Every department
 * without a team of its own id has an implicit team with the department's id.
 */
const teamSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(60),
  department: idSchema,
  /** Runtime preset of the team's shared runtime; defaults to its members' preset. */
  runtimePreset: idSchema.optional(),
});
export type TeamConfig = z.infer<typeof teamSchema>;

/** What a template's world is called as a whole, chosen by whoever imports it. */
export const termSchema = z.string().trim().min(1).max(40);

export const orgConfigSchema = z
  .object({
    organization: z.object({ id: idSchema, name: z.string(), language: z.enum(["en", "vi"]).default("en"), term: termSchema.optional() }),
    departments: z.array(z.object({ id: idSchema, name: z.string(), color: z.string().default("#8aa") })).min(1),
    projects: z.array(z.object({ id: idSchema, name: z.string() })).default([]),
    teams: z.array(teamSchema).default([]),
    runtimeCatalog: z.array(runtimePresetSchema).min(1),
    policyProfiles: z.record(z.string(), z.array(capabilitySchema)),
    agentTemplates: z.array(templateSchema).min(1),
    /**
     * Permission presets for people. Picking a role copies its permissions onto
     * the person; after that each permission can be added or removed one by one.
     */
    humanRoles: z.record(idSchema, z.object({ name: z.string(), permissions: z.array(capabilitySchema) })).default({}),
    bootstrap: z.object({ agents: z.array(bootstrapAgentSchema) }),
    /** Floors, rooms and objects; without it the office lays out one room per department. */
    world: worldSchema.optional(),
    /**
     * Owner-only kernel settings. worldEdits: whether agents allowed to design
     * (org.design) change the world at once ("auto") or each change waits for
     * the owner ("approve"). Callers without org.design always wait for the owner.
     */
    kernel: z
      .object({
        worldEdits: z.enum(["approve", "auto"]).default("approve"),
        /** Who decides agents' requests that need approval: the owner, or the agent at the top of the organization (its own run at once). */
        approver: z.enum(["owner", "lead"]).default("owner"),
      })
      .prefault({}),
  })
  .superRefine((cfg, ctx) => {
    const presets = new Set(cfg.runtimeCatalog.map((p) => p.id));
    const templates = new Set(cfg.agentTemplates.map((t) => t.id));
    const departments = new Set(cfg.departments.map((d) => d.id));
    for (const t of cfg.agentTemplates) {
      if (!presets.has(t.runtimePreset)) ctx.addIssue({ code: "custom", message: `template ${t.id}: unknown runtimePreset ${t.runtimePreset}` });
      if (!cfg.policyProfiles[t.policyProfile]) ctx.addIssue({ code: "custom", message: `template ${t.id}: unknown policyProfile ${t.policyProfile}` });
    }
    for (const [name, caps] of Object.entries(cfg.policyProfiles)) {
      for (const c of caps) {
        if (c.action === "agent.spawn" && !c.templates?.length) ctx.addIssue({ code: "custom", message: `profile ${name}: agent.spawn needs an explicit templates list` });
        if (c.action.startsWith("code.") && !c.repos?.length) ctx.addIssue({ code: "custom", message: `profile ${name}: ${c.action} needs an explicit repos list` });
        for (const t of c.templates ?? []) if (!templates.has(t)) ctx.addIssue({ code: "custom", message: `profile ${name}: unknown template ${t}` });
      }
    }
    const projects = new Set(cfg.projects.map((p) => p.id));
    if (cfg.world) checkWorld(cfg.world, departments, (message) => ctx.addIssue({ code: "custom", message }));
    const scopeRefs = (where: string, scope: Scope) => {
      if (scope.kind === "departments") for (const d of scope.ids) if (!departments.has(d)) ctx.addIssue({ code: "custom", message: `${where}: unknown department ${d}` });
      if (scope.kind === "projects") for (const p of scope.ids) if (!projects.has(p)) ctx.addIssue({ code: "custom", message: `${where}: unknown project ${p}` });
    };
    for (const [name, caps] of Object.entries(cfg.policyProfiles)) for (const c of caps) scopeRefs(`profile ${name}`, c.scope);
    for (const [name, role] of Object.entries(cfg.humanRoles)) for (const c of role.permissions) scopeRefs(`role ${name}`, c.scope);
    for (const [label, list] of [["department", cfg.departments], ["project", cfg.projects], ["agent template", cfg.agentTemplates]] as const) {
      const seen = new Set<string>();
      for (const { id } of list) {
        if (seen.has(id)) ctx.addIssue({ code: "custom", message: `duplicate ${label} id ${id}` });
        seen.add(id);
      }
    }
    for (const [name, role] of Object.entries(cfg.humanRoles)) {
      for (const c of role.permissions) {
        if (!USER_SCOPE_KINDS.includes(c.scope.kind)) ctx.addIssue({ code: "custom", message: `role ${name}: ${c.action} scope must be org, departments, agents or projects` });
        if (ORG_ACTIONS.includes(c.action) && c.scope.kind !== "org") ctx.addIssue({ code: "custom", message: `role ${name}: ${c.action} needs scope org` });
        if (c.action === "agent.spawn" && !c.templates?.length) ctx.addIssue({ code: "custom", message: `role ${name}: agent.spawn needs an explicit templates list` });
        if (c.action === "user.manage") ctx.addIssue({ code: "custom", message: `role ${name}: user.manage is given by the owner, not by a role` });
      }
    }
    const teamIds = new Set<string>();
    for (const t of cfg.teams) {
      if (!departments.has(t.department)) ctx.addIssue({ code: "custom", message: `team ${t.id}: unknown department ${t.department}` });
      if (t.runtimePreset && !presets.has(t.runtimePreset)) ctx.addIssue({ code: "custom", message: `team ${t.id}: unknown runtimePreset ${t.runtimePreset}` });
      if (departments.has(t.id) && t.id !== t.department) ctx.addIssue({ code: "custom", message: `team ${t.id}: id is the default team of department ${t.id}` });
      if (teamIds.has(t.id)) ctx.addIssue({ code: "custom", message: `duplicate team id ${t.id}` });
      teamIds.add(t.id);
    }
    const teamDept = new Map(teamsOf(cfg).map((t) => [t.id, t.department]));
    const keys = new Set<string>();
    for (const a of cfg.bootstrap.agents) {
      if (a.team && teamDept.get(a.team) !== a.department) ctx.addIssue({ code: "custom", message: `agent ${a.key}: team ${a.team} is not in department ${a.department}` });
      if (!templates.has(a.template)) ctx.addIssue({ code: "custom", message: `agent ${a.key}: unknown template` });
      if (!departments.has(a.department)) ctx.addIssue({ code: "custom", message: `agent ${a.key}: unknown department` });
      if (a.reportsTo && !keys.has(a.reportsTo)) ctx.addIssue({ code: "custom", message: `agent ${a.key}: reportsTo must reference an earlier agent` });
      keys.add(a.key);
    }
  });

export type OrgConfig = z.infer<typeof orgConfigSchema>;

/** All teams: the configured ones plus each department's implicit default team. */
export function teamsOf(cfg: Pick<OrgConfig, "teams" | "departments">): TeamConfig[] {
  const explicit = cfg.teams ?? [];
  const ids = new Set(explicit.map((t) => t.id));
  return [...explicit, ...cfg.departments.filter((d) => !ids.has(d.id)).map((d) => ({ id: d.id, name: d.name, department: d.id }))];
}

/** CPU quantity ("250m", "1", "0.5") in millicores. */
export function cpuMillis(q: string): number {
  const m = /^(\d+(?:\.\d+)?)(m?)$/.exec(q.trim());
  if (!m) throw new Error(`invalid cpu quantity ${q}`);
  return Math.round(m[2] ? Number(m[1]) : Number(m[1]) * 1000);
}

/** Memory quantity ("256Mi", "2Gi", "512M") in MiB. */
export function memoryMib(q: string): number {
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|K|M|G)?$/.exec(q.trim());
  if (!m) throw new Error(`invalid memory quantity ${q}`);
  const f: Record<string, number> = { Ki: 1 / 1024, Mi: 1, Gi: 1024, K: 1000 / 1048576, M: 1e6 / 1048576, G: 1e9 / 1048576, "": 1 / 1048576 };
  return Math.ceil(Number(m[1]) * f[m[2] ?? ""]!);
}

export function parseOrgConfig(text: string): OrgConfig {
  return orgConfigSchema.parse(parseYaml(text));
}

/**
 * The install config file holds the runtime catalog (allowed images: install-level,
 * never editable from the API) plus the first organization. An organization's own
 * structure document is the rest, kept in the author's format so it can be edited,
 * exported and imported as a template.
 */
export function splitInstanceConfig(text: string) {
  const config = parseOrgConfig(text); // validate the whole file first
  const { organization, runtimeCatalog, ...doc } = parseYaml(text) as Record<string, unknown>;
  return { config, catalog: runtimeCatalog, organization: config.organization, doc };
}

/** Validate an organization's document against the install's runtime catalog. */
export function orgConfigFrom(doc: unknown, organization: { id: string; name: string; language?: string; term?: string }, catalog: unknown): OrgConfig {
  return orgConfigSchema.parse({ ...(doc as Record<string, unknown>), organization, runtimeCatalog: catalog });
}

const templateMetaSchema = z.object({
  format: z.literal("agentown.template/v1"),
  // term: what the template's world is called as a whole ("café", "factory"), e.g. in "café language".
  meta: z.object({ id: idSchema, name: z.string().min(1).max(80), description: z.string().max(500).default(""), term: termSchema.optional() }),
});
export type TemplateMeta = z.infer<typeof templateMetaSchema>["meta"];

/**
 * An organization template: the same structure document an organization keeps
 * (departments, projects, agent templates, policy profiles, role presets,
 * bootstrap agents) plus a format tag and meta. Templates are untrusted input
 * (imported files, a future marketplace), so parsing is bounded.
 */
export function parseTemplate(text: string, catalog: unknown): { meta: TemplateMeta; doc: Record<string, unknown> } {
  if (text.length > 256 * 1024) throw new Error("template too large (256 KB max)");
  const raw = parseYaml(text, { maxAliasCount: 50 }) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new Error("template must be a YAML mapping");
  const { meta } = templateMetaSchema.parse(raw);
  const { format: _f, meta: _m, organization: _o, runtimeCatalog: _r, ...doc } = raw;
  orgConfigFrom(doc, { id: meta.id, name: meta.name }, catalog); // throws on any structural problem
  return { meta, doc };
}
