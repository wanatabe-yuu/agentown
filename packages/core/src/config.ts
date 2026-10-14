import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ACTIONS, type Action, type Scope } from "./types.ts";

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
export const ORG_ACTIONS: readonly Action[] = ["credential.manage", "audit.view", "user.manage"];
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
  resources: z
    .object({ cpu: z.string().default("500m"), memory: z.string().default("512Mi") })
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
  reportsTo: idSchema.nullable().default(null),
});

export const orgConfigSchema = z
  .object({
    organization: z.object({ id: idSchema, name: z.string() }),
    departments: z.array(z.object({ id: idSchema, name: z.string(), color: z.string().default("#8aa") })).min(1),
    projects: z.array(z.object({ id: idSchema, name: z.string() })).default([]),
    runtimeCatalog: z.array(runtimePresetSchema).min(1),
    policyProfiles: z.record(z.string(), z.array(capabilitySchema)),
    agentTemplates: z.array(templateSchema).min(1),
    /**
     * Permission presets for people. Picking a role copies its permissions onto
     * the person; after that each permission can be added or removed one by one.
     */
    humanRoles: z.record(idSchema, z.object({ name: z.string(), permissions: z.array(capabilitySchema) })).default({}),
    bootstrap: z.object({ agents: z.array(bootstrapAgentSchema) }),
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
    for (const [name, role] of Object.entries(cfg.humanRoles)) {
      for (const c of role.permissions) {
        if (!USER_SCOPE_KINDS.includes(c.scope.kind)) ctx.addIssue({ code: "custom", message: `role ${name}: ${c.action} scope must be org, departments, agents or projects` });
        if (ORG_ACTIONS.includes(c.action) && c.scope.kind !== "org") ctx.addIssue({ code: "custom", message: `role ${name}: ${c.action} needs scope org` });
        if (c.action === "agent.spawn" && !c.templates?.length) ctx.addIssue({ code: "custom", message: `role ${name}: agent.spawn needs an explicit templates list` });
        if (c.action === "user.manage") ctx.addIssue({ code: "custom", message: `role ${name}: user.manage is given by the owner, not by a role` });
      }
    }
    const keys = new Set<string>();
    for (const a of cfg.bootstrap.agents) {
      if (!templates.has(a.template)) ctx.addIssue({ code: "custom", message: `agent ${a.key}: unknown template` });
      if (!departments.has(a.department)) ctx.addIssue({ code: "custom", message: `agent ${a.key}: unknown department` });
      if (a.reportsTo && !keys.has(a.reportsTo)) ctx.addIssue({ code: "custom", message: `agent ${a.key}: reportsTo must reference an earlier agent` });
      keys.add(a.key);
    }
  });

export type OrgConfig = z.infer<typeof orgConfigSchema>;

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
export function orgConfigFrom(doc: unknown, organization: { id: string; name: string }, catalog: unknown): OrgConfig {
  return orgConfigSchema.parse({ ...(doc as Record<string, unknown>), organization, runtimeCatalog: catalog });
}

const templateMetaSchema = z.object({
  format: z.literal("agentown.template/v1"),
  meta: z.object({ id: idSchema, name: z.string().min(1).max(80), description: z.string().max(500).default("") }),
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
