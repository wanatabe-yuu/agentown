import { worldIdentities } from "./world-identities.ts";
import { type Language, translateNames } from "./locales.ts";
import { readdirSync, readFileSync } from "node:fs";
import { stringify } from "yaml";
import { join } from "node:path";
import { type Actor, orgConfigFrom, parseTemplate, splitInstanceConfig, type TemplateMeta } from "@agentown/core";
import { z } from "zod";
import type { EventBus } from "./bus.ts";
import { type Db, tx } from "./db.ts";
import type { Computers } from "./computers.ts";
import type { ModelLister } from "./providers.ts";
import type { SecretBox } from "./secrets.ts";
import { Service } from "./service.ts";
import { ApiError, badRequest, conflict, deny, newId, notFound, sha256 } from "./util.ts";

const ORG_ID = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/** Preserve the author's document, changing only legacy template presets. */
function upgradeScriptTemplates(doc: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(doc.agentTemplates)) return doc;
  let changed = false;
  const agentTemplates = doc.agentTemplates.map((t) => {
    if (!t || typeof t !== "object" || t.runtimePreset !== "script-v1") return t;
    changed = true;
    return { ...t, runtimePreset: "claude-v1" };
  });
  return changed ? { ...doc, agentTemplates } : doc;
}

export interface OrgTemplate {
  meta: TemplateMeta;
  doc: Record<string, unknown>;
  builtIn: boolean;
}

/** Who a token belongs to, before any organization is chosen. */
export type Principal =
  | { kind: "human"; id: string; admin: boolean }
  | { kind: "agent"; id: string; orgId: string }
  /** A team's shared runtime. It only lists its members and starts sessions for them; members act with their own tokens. */
  | { kind: "runtime"; id: string; orgId: string; teamId: string }
  /** A computer's pod: it only connects its browser (see computers.ts). */
  | { kind: "computer"; id: string; orgId: string; objectId: string };

/**
 * The install: accounts, tokens and the list of organizations. Everything inside
 * an organization goes through that org's Service, which confines every query to
 * it; this class only decides which Service a request gets.
 */
export class Instance {
  private readonly cache = new Map<string, { revision: number; name: string; service: Service }>();
  /** The world's computers (set by the app). */
  computers: Computers | null = null;
  private readonly file: ReturnType<typeof splitInstanceConfig>;
  /** Built-in organization templates: the config file's own org ("company") plus templatesDir/*.yaml. */
  readonly builtInTemplates = new Map<string, OrgTemplate>();

  constructor(
    readonly db: Db,
    configText: string,
    readonly bus: EventBus,
    readonly secrets: SecretBox,
    private readonly modelLister: ModelLister,
    templatesDir?: string,
  ) {
    this.file = splitInstanceConfig(configText);
    const upgradeScripts = this.runtimeCatalog.some((p) => p.id === "claude-v1" && p.harness === "claude");
    if (upgradeScripts) this.file.doc = upgradeScriptTemplates(this.file.doc);
    const { organization, doc } = this.file;
    this.builtInTemplates.set("company", {
      meta: { id: "company", name: "Company", description: `The ${organization.name} organization this install shipped with.`, term: "company" },
      doc,
      builtIn: true,
    });
    for (const f of templatesDir ? readdirSync(templatesDir).filter((n) => n.endsWith(".yaml")).sort() : []) {
      let t: ReturnType<typeof parseTemplate>;
      try {
        t = parseTemplate(readFileSync(join(templatesDir!, f), "utf8"), this.file.catalog);
      } catch (err) {
        // A customized install may not approve the runtimes needed by a shipped
        // template. Omit that template, while still surfacing other invalid files.
        if (err instanceof z.ZodError && err.issues.every((i) => i.code === "custom" && /^template .+: unknown runtimePreset /.test(i.message))) continue;
        throw err;
      }
      this.builtInTemplates.set(t.meta.id, { ...t, doc: upgradeScripts ? upgradeScriptTemplates(t.doc) : t.doc, builtIn: true });
    }
  }

  /** Allowed runtime presets (images): from the install file only. */
  get runtimeCatalog() {
    return this.file.config.runtimeCatalog;
  }

  get defaultOrgId() {
    return this.file.organization.id;
  }

  async authenticate(token: string | undefined): Promise<Principal | null> {
    if (!token) return null;
    const { rows } = await this.db.query<{ principal_kind: string; principal_id: string; is_admin: boolean | null; disabled_at: Date | null; org_id: string | null }>(
      `SELECT t.principal_kind, t.principal_id, u.is_admin, u.disabled_at, a.org_id
         FROM tokens t
         LEFT JOIN users u ON t.principal_kind = 'human' AND u.id = t.principal_id
         LEFT JOIN agents a ON t.principal_kind = 'agent' AND a.id = t.principal_id
        WHERE t.hash = $1 AND t.revoked_at IS NULL`,
      [sha256(token)],
    );
    const r = rows[0];
    if (!r) return null;
    if (r.principal_kind === "human") {
      if (r.is_admin === null || r.disabled_at) return null;
      return { kind: "human", id: r.principal_id, admin: r.is_admin };
    }
    if (r.principal_kind === "runtime") {
      const [orgId, teamId] = r.principal_id.split("/") as [string, string];
      return { kind: "runtime", id: r.principal_id, orgId, teamId };
    }
    if (r.principal_kind === "computer") {
      const [orgId, objectId] = r.principal_id.split("/") as [string, string];
      return { kind: "computer", id: r.principal_id, orgId, objectId };
    }
    return r.org_id ? { kind: "agent", id: r.principal_id, orgId: r.org_id } : null;
  }

  /** The Service of one organization, rebuilt whenever its document changes. Archived orgs are not found. */
  async org(orgId: string, opts: { includeArchived?: boolean } = {}): Promise<Service> {
    const { rows } = await this.db.query<{ name: string; language: string; term: string | null; template_id: string | null; config: unknown; config_revision: number; archived_at: Date | null; runtime_namespace: string | null }>(
      "SELECT name, language, term, template_id, config, config_revision, archived_at, runtime_namespace FROM organizations WHERE id=$1",
      [orgId],
    );
    const o = rows[0];
    if (!o || !o.config || (o.archived_at && !opts.includeArchived)) throw notFound("organization");
    const hit = this.cache.get(orgId);
    if (hit && hit.revision === o.config_revision && hit.name === o.name) return hit.service;
    let config;
    try {
      // Organizations made before terms existed take their built-in template's.
      const term = o.term ?? this.builtInTemplates.get(o.template_id ?? "company")?.meta.term;
      config = orgConfigFrom(o.config, { id: orgId, name: o.name, language: o.language, ...(term ? { term } : {}) }, this.file.catalog);
    } catch (err) {
      // A document this server cannot read (edited elsewhere, newer format): fail this org's requests, nothing else.
      throw new ApiError(503, "org_config_invalid", `organization ${orgId} has a configuration this server cannot load: ${err instanceof z.ZodError ? z.prettifyError(err).slice(0, 500) : (err as Error).message}`);
    }
    const service = new Service(this.db, config, this.bus, this.secrets, this.modelLister, orgId, o.runtime_namespace);
    this.cache.set(orgId, { revision: o.config_revision, name: o.name, service });
    return service;
  }

  async activeOrgIds(): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>("SELECT id FROM organizations WHERE archived_at IS NULL AND config IS NOT NULL ORDER BY id");
    return rows.map((r) => r.id);
  }

  /**
   * The organization a request acts in, and the actor as that org sees it.
   * Agents are confined to their own org; a person must be an active member.
   * Anything else is "not found", so org ids are not probeable.
   */
  async resolve(p: Principal, orgId: string | undefined): Promise<{ service: Service; actor: Actor }> {
    if (p.kind === "runtime" || p.kind === "computer") throw deny("a runtime acts through its members' session tokens");
    if (p.kind === "agent") {
      if (orgId && orgId !== p.orgId) throw notFound("organization");
      return { service: await this.org(p.orgId), actor: { kind: "agent", id: p.id } };
    }
    if (!orgId) throw badRequest("choose an organization: use /api/orgs/<id>/…");
    const { rows } = await this.db.query<{ is_owner: boolean }>(
      "SELECT is_owner FROM org_members WHERE org_id=$1 AND user_id=$2 AND disabled_at IS NULL",
      [orgId, p.id],
    );
    if (!rows[0]) throw notFound("organization");
    return { service: await this.org(orgId), actor: { kind: "human", id: p.id, owner: rows[0].is_owner } };
  }

  /** The signed-in person and the organizations they can open. */
  async me(p: Principal) {
    if (p.kind !== "human") return { user: null, orgs: [{ id: p.orgId }] };
    const user = (await this.db.query("SELECT id, display_name FROM users WHERE id=$1", [p.id])).rows[0];
    const { rows } = await this.db.query<{ id: string; name: string; is_owner: boolean }>(
      `SELECT o.id, o.name, m.is_owner FROM org_members m JOIN organizations o ON o.id = m.org_id
        WHERE m.user_id=$1 AND m.disabled_at IS NULL AND o.archived_at IS NULL AND o.config IS NOT NULL ORDER BY o.name`,
      [p.id],
    );
    return {
      user: { id: user.id as string, displayName: user.display_name as string, admin: p.admin },
      orgs: rows.map((r) => ({ id: r.id, name: r.name, owner: r.is_owner })),
    };
  }

  /**
   * First boot: create the config file's organization, with the instance admin as
   * its owner. An install upgraded from a single organization gets its document
   * filled in once. After that the database, not the file, owns the structure.
   * Returns a fresh admin token only when none exists yet.
   */
  async bootstrap(opts: { ownerToken?: string } = {}): Promise<{ ownerToken: string | null }> {
    await this.upgradeScriptTemplates();
    const { organization, doc } = this.file;
    const seed = await tx(this.db, async (c) => {
      const { rows } = await c.query<{ id: string; config: unknown }>("SELECT id, config FROM organizations");
      const existing = rows.find((r) => r.id === organization.id);
      if (!rows.length) {
        await c.query("INSERT INTO organizations(id, name, config, created_by) VALUES ($1,$2,$3,'system:config')", [organization.id, organization.name, JSON.stringify(worldIdentities(doc))]);
        await c.query("INSERT INTO org_members(org_id, user_id, is_owner, created_by) VALUES ($1,'owner',true,'system:config')", [organization.id]);
        return true;
      }
      if (existing && !existing.config) {
        await c.query("UPDATE organizations SET config=$2 WHERE id=$1", [organization.id, JSON.stringify(worldIdentities(doc))]);
        return true;
      }
      return false;
    });
    const service = seed ? await this.org(organization.id) : null;
    if (service) await service.seedBootstrapAgents();

    // Also works without a runtime driver. Busy agents are retried by the controller.
    const pending = await this.db.query<{ agent_id: string; org_id: string }>(
      "SELECT r.agent_id, a.org_id FROM agent_runtimes r JOIN agents a ON a.id=r.agent_id WHERE r.pending_preset_id=ANY($1::text[])",
      [this.runtimeCatalog.filter((p) => p.harness === "claude").map((p) => p.id)],
    );
    for (const r of pending.rows) {
      let org: Service;
      try {
        org = await this.org(r.org_id, { includeArchived: true });
      } catch (err) {
        // An unreadable org stays pending; the controller logs it without blocking other orgs.
        if (err instanceof ApiError && err.code === "org_config_invalid") continue;
        throw err;
      }
      await org.applyPendingRuntimeUpgrade(r.agent_id);
    }

    const { rows } = await this.db.query("SELECT 1 FROM tokens WHERE principal_kind='human' AND principal_id='owner' AND revoked_at IS NULL");
    if (rows[0]) return { ownerToken: null };
    if (opts.ownerToken) {
      await this.db.query("INSERT INTO tokens(hash, principal_kind, principal_id, label) VALUES ($1,'human','owner','bootstrap')", [sha256(opts.ownerToken)]);
      return { ownerToken: opts.ownerToken };
    }
    const any = service ?? (await this.org(organization.id));
    return { ownerToken: await any.issueToken(this.db, "human", "owner", "bootstrap", false) };
  }

  /** Config-dependent data migration: leave it pending if the install has no LLM preset. */
  private async upgradeScriptTemplates(): Promise<void> {
    if (!this.runtimeCatalog.some((p) => p.id === "claude-v1" && p.harness === "claude")) return;
    await tx(this.db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7340211)");
      if ((await c.query("SELECT 1 FROM data_migrations WHERE name='script-v1-to-claude-v1'")).rowCount) return;
      for (const [table, column] of [["organizations", "config"], ["templates", "doc"]] as const) {
        const { rows } = await c.query<{ id: string; doc: Record<string, unknown> }>(`SELECT id, ${column} AS doc FROM ${table} WHERE ${column} IS NOT NULL FOR UPDATE`);
        for (const r of rows) {
          const doc = upgradeScriptTemplates(r.doc);
          if (doc === r.doc) continue;
          await c.query(`UPDATE ${table} SET ${column}=$2${table === "organizations" ? ", config_revision=config_revision+1" : ""} WHERE id=$1`, [r.id, JSON.stringify(worldIdentities(doc))]);
        }
      }
      await c.query("INSERT INTO data_migrations(name) VALUES ('script-v1-to-claude-v1')");
    });
  }

  // ---------------------------------------------------------------- instance admin

  private requireAdmin(p: Principal): void {
    if (p.kind !== "human" || !p.admin) throw deny("only the instance admin can manage organizations");
  }

  private async auditInstance(p: Principal, action: string, target: string, detail: Record<string, unknown>, orgId: string | null = null) {
    await this.db.query("INSERT INTO audit_events(org_id, actor, action, target, allowed, reason, detail) VALUES ($1,$2,$3,$4,true,'instance admin',$5)", [
      orgId,
      `${p.kind}:${p.id}`,
      action,
      target,
      JSON.stringify(detail),
    ]);
  }

  // ---------------------------------------------------------------- templates

  private requireHuman(p: Principal): asserts p is Extract<Principal, { kind: "human" }> {
    if (p.kind !== "human") throw deny("templates are for people");
  }

  /** Built-ins for everyone; saved and imported ones for their author (the admin sees all). */
  async listTemplates(p: Principal) {
    this.requireHuman(p);
    const { rows } = await this.db.query(
      `SELECT t.id, t.name, t.description, t.term, t.doc, t.owner_user_id, u.display_name AS owner_name, t.source_org_id, t.created_at
         FROM templates t JOIN users u ON u.id = t.owner_user_id WHERE $2 OR t.owner_user_id = $1 ORDER BY t.created_at`,
      [p.id, p.admin],
    );
    const summary = (doc: Record<string, unknown>) => (doc.departments as Array<{ name: string }>).map((d) => d.name);
    return [
      ...[...this.builtInTemplates.values()].map((t) => ({ ...t.meta, builtIn: true, owner: null, departments: summary(t.doc) })),
      ...rows.map((r) => ({
        id: r.id as string,
        name: r.name as string,
        description: r.description as string,
        term: (r.term as string | null) ?? undefined,
        builtIn: false,
        owner: { id: r.owner_user_id as string, displayName: r.owner_name as string },
        sourceOrgId: r.source_org_id as string | null,
        departments: summary(r.doc),
      })),
    ];
  }

  private async getTemplate(p: Principal, id: string): Promise<OrgTemplate> {
    this.requireHuman(p);
    const builtIn = this.builtInTemplates.get(id);
    if (builtIn) return builtIn;
    const { rows } = await this.db.query("SELECT * FROM templates WHERE id=$1 AND ($3 OR owner_user_id=$2)", [id, p.id, p.admin]);
    if (!rows[0]) throw notFound("template");
    return { meta: { id: rows[0].id, name: rows[0].name, description: rows[0].description, term: rows[0].term ?? undefined }, doc: rows[0].doc, builtIn: false };
  }

  /** Portable YAML: what a marketplace would carry. */
  async exportTemplate(p: Principal, id: string): Promise<string> {
    const t = await this.getTemplate(p, id);
    return stringify({ format: "agentown.template/v1", meta: t.meta, ...t.doc });
  }

  private async storeTemplate(p: Principal, meta: { name: string; description: string; term?: string }, doc: Record<string, unknown>, sourceOrgId: string | null) {
    this.requireHuman(p);
    const id = newId("tpl");
    orgConfigFrom(doc, { id, name: meta.name }, this.file.catalog); // never store something an org could not be made from
    await this.db.query("INSERT INTO templates(id, name, description, doc, owner_user_id, source_org_id, term) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
      id,
      meta.name,
      meta.description,
      JSON.stringify(doc),
      p.id,
      sourceOrgId,
      meta.term ?? null,
    ]);
    await this.auditInstance(p, "template.create", id, { name: meta.name, sourceOrgId }, sourceOrgId);
    return (await this.listTemplates(p)).find((t) => t.id === id)!;
  }

  /** Import a template file (untrusted: size- and alias-bounded, validated against this install's catalog). */
  /** `term` (what its world is called as a whole) overrides the file's own. */
  async importTemplate(p: Principal, yaml: string, term?: string) {
    this.requireHuman(p);
    let parsed: ReturnType<typeof parseTemplate>;
    try {
      parsed = parseTemplate(yaml, this.file.catalog);
    } catch (err) {
      throw badRequest(`not a usable template: ${err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message}`);
    }
    return this.storeTemplate(p, { name: parsed.meta.name, description: parsed.meta.description, term: term ?? parsed.meta.term }, parsed.doc, null);
  }

  /** Save an organization (structure + current agent tree) as a template in the owner's library. */
  async saveOrgAsTemplate(p: Principal, service: Service, actor: Actor, meta: { name: string; description: string; term?: string }) {
    return this.storeTemplate(p, { ...meta, term: meta.term ?? service.config.organization.term }, await service.asTemplateDoc(actor), service.orgId);
  }

  async deleteTemplate(p: Principal, id: string) {
    this.requireHuman(p);
    if (this.builtInTemplates.has(id)) throw deny("built-in templates cannot be deleted");
    const r = await this.db.query("DELETE FROM templates WHERE id=$1 AND ($3 OR owner_user_id=$2)", [id, p.id, p.admin]);
    if (!r.rowCount) throw notFound("template");
    await this.auditInstance(p, "template.delete", id, {});
  }

  /** Change an organization's world (org.design), validated like any document. */
  async updateOrgWorld(service: Service, actor: Actor, input: { revision: number; world: Record<string, unknown> | null }) {
    const org = (await this.db.query("SELECT name FROM organizations WHERE id=$1", [service.orgId])).rows[0];
    return service.replaceWorld(actor, input, (doc) => orgConfigFrom(doc, { id: service.orgId, name: org.name }, this.file.catalog));
  }

  /** Would this world be accepted (as a whole document)? Throws the same error a save would, saves nothing. */
  async checkOrgWorld(service: Service, world: Record<string, unknown> | null) {
    const { rows } = await this.db.query("SELECT name, config FROM organizations WHERE id=$1", [service.orgId]);
    const { world: _old, ...rest } = rows[0].config as Record<string, unknown>;
    try {
      orgConfigFrom(worldIdentities(world ? { ...rest, world } : rest), { id: service.orgId, name: rows[0].name }, this.file.catalog);
    } catch (err) {
      throw badRequest(err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message);
    }
  }

  /** Change an organization's structure, validated against this install's runtime catalog. */
  async updateOrgConfig(service: Service, actor: Actor, input: { revision: number; doc: Record<string, unknown> }) {
    const org = (await this.db.query("SELECT name FROM organizations WHERE id=$1", [service.orgId])).rows[0];
    return service.replaceConfig(actor, input, (doc) => orgConfigFrom(doc, { id: service.orgId, name: org.name }, this.file.catalog));
  }

  async listOrgs(p: Principal) {
    this.requireAdmin(p);
    const { rows } = await this.db.query(
      `SELECT o.id, o.name, o.template_id, o.created_at, o.archived_at, o.runtime_namespace,
              (SELECT json_build_object('id', u.id, 'displayName', u.display_name) FROM org_members m JOIN users u ON u.id = m.user_id
                WHERE m.org_id = o.id AND m.is_owner) AS owner,
              (SELECT count(*)::int FROM agents a WHERE a.org_id = o.id AND a.lifecycle_state <> 'retired') AS agents,
              (SELECT count(*)::int FROM org_members m WHERE m.org_id = o.id) AS members
         FROM organizations o ORDER BY o.created_at`,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      templateId: r.template_id,
      createdAt: r.created_at.toISOString(),
      archivedAt: r.archived_at?.toISOString() ?? null,
      runtimeNamespace: r.runtime_namespace,
      owner: r.owner,
      agents: r.agents,
      members: r.members,
    }));
  }

  /** Accounts on the install, so an existing person can be made an org's owner. */
  async listAccounts(p: Principal) {
    this.requireAdmin(p);
    const { rows } = await this.db.query("SELECT id, display_name, is_admin, disabled_at FROM users ORDER BY is_admin DESC, display_name");
    return rows.map((r) => ({ id: r.id, displayName: r.display_name, admin: r.is_admin, disabled: !!r.disabled_at }));
  }

  /**
   * New organization from a template, in its own Kubernetes namespace. The owner
   * is an existing account or a new person, whose token is returned once.
   */
  async createOrg(p: Principal, input: { id: string; name: string; templateId: string; language?: Language; owner: { userId: string } | { displayName: string } }) {
    this.requireAdmin(p);
    if (!ORG_ID.test(input.id)) throw badRequest("organization id: lowercase letters, digits and dashes, at most 40 characters");
    const template = await this.getTemplate(p, input.templateId).catch(() => {
      throw badRequest(`unknown template ${input.templateId}`);
    });
    const namespace = `agentown-o-${input.id}`;
    const created = await tx(this.db, async (c) => {
      if ((await c.query("SELECT 1 FROM organizations WHERE id=$1", [input.id])).rowCount) throw conflict("exists", "an organization with this id already exists");
      if ((await c.query("SELECT 1 FROM agent_runtimes WHERE namespace=$1 LIMIT 1", [namespace])).rowCount) throw conflict("namespace_taken", `namespace ${namespace} is in use`);
      await c.query(
        "INSERT INTO organizations(id, name, config, template_id, created_by, runtime_namespace, language, term) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [input.id, input.name, JSON.stringify(worldIdentities(translateNames(template.doc, "en", input.language ?? "en"))), template.meta.id, `human:${p.id}`, namespace, input.language ?? "en", template.meta.term ?? null],
      );
      let ownerId: string;
      const newPerson = !("userId" in input.owner);
      if ("userId" in input.owner) {
        ownerId = input.owner.userId;
        if (!(await c.query("SELECT 1 FROM users WHERE id=$1 AND disabled_at IS NULL", [ownerId])).rowCount) throw notFound("user");
      } else {
        ownerId = newId("u");
        await c.query("INSERT INTO users(id, display_name, created_by) VALUES ($1,$2,$3)", [ownerId, input.owner.displayName, `human:${p.id}`]);
      }
      await c.query("INSERT INTO org_members(org_id, user_id, is_owner, created_by) VALUES ($1,$2,true,$3)", [input.id, ownerId, `human:${p.id}`]);
      return { ownerId, newPerson };
    });
    const service = await this.org(input.id);
    await service.seedBootstrapAgents({ freshIds: true });
    const token = created.newPerson ? await service.issueToken(this.db, "human", created.ownerId, "invite", true) : null;
    await this.auditInstance(p, "org.create", input.id, { templateId: input.templateId, owner: created.ownerId }, input.id);
    return { org: (await this.listOrgs(p)).find((o) => o.id === input.id)!, ownerToken: token };
  }

  /** Rename, change the owner, archive (stops every runtime; members get "not found") or restore. */
  async updateOrg(p: Principal, id: string, input: { name?: string; ownerUserId?: string; archived?: boolean }) {
    this.requireAdmin(p);
    await tx(this.db, async (c) => {
      if (!(await c.query("SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE", [id])).rowCount) throw notFound("organization");
      if (input.name) await c.query("UPDATE organizations SET name=$2 WHERE id=$1", [id, input.name]);
      if (input.ownerUserId) {
        if (!(await c.query("SELECT 1 FROM users WHERE id=$1 AND disabled_at IS NULL", [input.ownerUserId])).rowCount) throw notFound("user");
        await c.query("UPDATE org_members SET is_owner=false WHERE org_id=$1 AND is_owner", [id]);
        await c.query(
          `INSERT INTO org_members(org_id, user_id, is_owner, created_by) VALUES ($1,$2,true,$3)
           ON CONFLICT (org_id, user_id) DO UPDATE SET is_owner=true, disabled_at=NULL`,
          [id, input.ownerUserId, `human:${p.id}`],
        );
      }
      if (input.archived === true) {
        await c.query("UPDATE organizations SET archived_at=COALESCE(archived_at, now()) WHERE id=$1", [id]);
        await c.query("UPDATE agents SET desired_runtime='stopped' WHERE org_id=$1 AND lifecycle_state <> 'retired'", [id]);
      } else if (input.archived === false) {
        await c.query("UPDATE organizations SET archived_at=NULL WHERE id=$1", [id]);
        await c.query("UPDATE agents SET desired_runtime='running' WHERE org_id=$1 AND lifecycle_state <> 'retired'", [id]);
      }
    });
    await this.auditInstance(p, "org.update", id, input, id);
    return (await this.listOrgs(p)).find((o) => o.id === id)!;
  }

  /** Open terminals that must close, across all organizations. */
  async terminalsToRevoke(): Promise<Array<{ id: string; orgId: string; reason: string }>> {
    const out: Array<{ id: string; orgId: string; reason: string }> = [];
    const { rows } = await this.db.query<{ org_id: string; archived: boolean }>(
      `SELECT DISTINCT s.org_id, o.archived_at IS NOT NULL AS archived FROM terminal_sessions s JOIN organizations o ON o.id = s.org_id
        WHERE s.closed_at IS NULL AND s.attached_at IS NOT NULL`,
    );
    for (const r of rows) {
      if (r.archived) {
        const open = await this.db.query<{ id: string }>("SELECT id FROM terminal_sessions WHERE org_id=$1 AND closed_at IS NULL", [r.org_id]);
        for (const s of open.rows) out.push({ id: s.id, orgId: r.org_id, reason: "organization archived" });
        continue;
      }
      for (const t of await (await this.org(r.org_id)).terminalsToRevoke()) out.push({ ...t, orgId: r.org_id });
    }
    return out;
  }

  async sweepLeases(): Promise<number> {
    let n = 0;
    for (const id of await this.activeOrgIds()) n += await this.org(id).then((o) => o.sweepLeases(), () => 0);
    return n;
  }
}
