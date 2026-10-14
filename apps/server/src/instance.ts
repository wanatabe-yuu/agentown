import { type Actor, orgConfigFrom, splitInstanceConfig } from "@agentown/core";
import type { EventBus } from "./bus.ts";
import { type Db, tx } from "./db.ts";
import type { ModelLister } from "./providers.ts";
import type { SecretBox } from "./secrets.ts";
import { Service } from "./service.ts";
import { badRequest, notFound, sha256 } from "./util.ts";

/** Who a token belongs to, before any organization is chosen. */
export type Principal = { kind: "human"; id: string; admin: boolean } | { kind: "agent"; id: string; orgId: string };

/**
 * The install: accounts, tokens and the list of organizations. Everything inside
 * an organization goes through that org's Service, which confines every query to
 * it; this class only decides which Service a request gets.
 */
export class Instance {
  private readonly cache = new Map<string, { revision: number; name: string; service: Service }>();
  private readonly file: ReturnType<typeof splitInstanceConfig>;

  constructor(
    readonly db: Db,
    configText: string,
    readonly bus: EventBus,
    readonly secrets: SecretBox,
    private readonly modelLister: ModelLister,
  ) {
    this.file = splitInstanceConfig(configText);
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
    return r.org_id ? { kind: "agent", id: r.principal_id, orgId: r.org_id } : null;
  }

  /** The Service of one organization, rebuilt whenever its document changes. Archived orgs are not found. */
  async org(orgId: string, opts: { includeArchived?: boolean } = {}): Promise<Service> {
    const { rows } = await this.db.query<{ name: string; config: unknown; config_revision: number; archived_at: Date | null }>(
      "SELECT name, config, config_revision, archived_at FROM organizations WHERE id=$1",
      [orgId],
    );
    const o = rows[0];
    if (!o || !o.config || (o.archived_at && !opts.includeArchived)) throw notFound("organization");
    const hit = this.cache.get(orgId);
    if (hit && hit.revision === o.config_revision && hit.name === o.name) return hit.service;
    const config = orgConfigFrom(o.config, { id: orgId, name: o.name }, this.file.catalog);
    const service = new Service(this.db, config, this.bus, this.secrets, this.modelLister, orgId);
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
    if (p.kind === "agent") return { user: null, orgs: [{ id: p.orgId }] };
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
    const { organization, doc } = this.file;
    const seed = await tx(this.db, async (c) => {
      const { rows } = await c.query<{ id: string; config: unknown }>("SELECT id, config FROM organizations");
      const existing = rows.find((r) => r.id === organization.id);
      if (!rows.length) {
        await c.query("INSERT INTO organizations(id, name, config, created_by) VALUES ($1,$2,$3,'system:config')", [organization.id, organization.name, JSON.stringify(doc)]);
        await c.query("INSERT INTO org_members(org_id, user_id, is_owner, created_by) VALUES ($1,'owner',true,'system:config')", [organization.id]);
        return true;
      }
      if (existing && !existing.config) {
        await c.query("UPDATE organizations SET config=$2 WHERE id=$1", [organization.id, JSON.stringify(doc)]);
        return true;
      }
      return false;
    });
    const service = seed ? await this.org(organization.id) : null;
    if (service) await service.seedBootstrapAgents();

    const { rows } = await this.db.query("SELECT 1 FROM tokens WHERE principal_kind='human' AND principal_id='owner' AND revoked_at IS NULL");
    if (rows[0]) return { ownerToken: null };
    if (opts.ownerToken) {
      await this.db.query("INSERT INTO tokens(hash, principal_kind, principal_id, label) VALUES ($1,'human','owner','bootstrap')", [sha256(opts.ownerToken)]);
      return { ownerToken: opts.ownerToken };
    }
    const any = service ?? (await this.org(organization.id));
    return { ownerToken: await any.issueToken(this.db, "human", "owner", "bootstrap", false) };
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
    for (const id of await this.activeOrgIds()) n += await (await this.org(id)).sweepLeases();
    return n;
  }
}
