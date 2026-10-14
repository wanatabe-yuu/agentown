import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ACTIONS, type Scope } from "./types.ts";

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
]);

const capabilitySchema = z.object({
  action: z.enum(ACTIONS),
  scope: scopeSchema,
  templates: z.array(z.string()).optional(),
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
  workspace: z.object({ size: z.string().default("1Gi") }).default({}),
  resources: z
    .object({ cpu: z.string().default("500m"), memory: z.string().default("512Mi") })
    .default({}),
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
        for (const t of c.templates ?? []) if (!templates.has(t)) ctx.addIssue({ code: "custom", message: `profile ${name}: unknown template ${t}` });
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
