import type { Actor } from "@agentown/core";
import type { Queryable } from "../db.ts";
import { newSecret, sha256 } from "../util.ts";
import type { Permissions } from "./permissions.ts";

/** Identity: who is acting — people, agents and team runtimes — and the tokens they act with. */

/** Members of $1; disabled when either the membership or the whole account is. */
export const MEMBERS_SQL = `
  SELECT u.id, u.display_name, m.role_id, m.is_owner, COALESCE(m.disabled_at, u.disabled_at) AS disabled_at, m.created_by, m.created_at
    FROM org_members m JOIN users u ON u.id = m.user_id
   WHERE m.org_id = $1`;

export class Identity {
  constructor(
    private readonly db: Queryable,
    private readonly orgId: string,
    private readonly permissions: Permissions,
  ) {}

  /** A bearer token for a person or an agent; with rotate, the principal's earlier tokens stop working. */
  async issueToken(q: Queryable, kind: "human" | "agent", principalId: string, label: string, rotate: boolean): Promise<string> {
    if (rotate) {
      await q.query("UPDATE tokens SET revoked_at = now() WHERE principal_kind=$1 AND principal_id=$2 AND revoked_at IS NULL", [kind, principalId]);
    }
    const token = `${kind === "human" ? "aho" : "aag"}_${newSecret()}`;
    await q.query("INSERT INTO tokens(hash, principal_kind, principal_id, label) VALUES ($1,$2,$3,$4)", [sha256(token), kind, principalId, label]);
    return token;
  }

  /** An agent's own runtime token (pre-team runtimes). */
  async issueAgentToken(agentId: string): Promise<string> {
    const token = await this.issueToken(this.db, "agent", agentId, "runtime", true);
    await this.permissions.audit(this.db, "system:controller", "token.issue", agentId, true, "runtime credential (re)created");
    return token;
  }

  /** A team runtime's token: it can only list its members and start sessions for them. */
  async issueRuntimeToken(teamId: string): Promise<string> {
    const principal = `${this.orgId}/${teamId}`;
    await this.db.query("UPDATE tokens SET revoked_at=now() WHERE principal_kind='runtime' AND principal_id=$1 AND revoked_at IS NULL", [principal]);
    const token = `art_${newSecret()}`;
    await this.db.query("INSERT INTO tokens(hash, principal_kind, principal_id, label) VALUES ($1,'runtime',$2,'team runtime')", [sha256(token), principal]);
    await this.permissions.audit(this.db, "system:controller", "token.issue", principal, true, "team runtime credential (re)created");
    return token;
  }

  async revokeAgentTokens(q: Queryable, agentId: string): Promise<void> {
    await q.query("UPDATE tokens SET revoked_at=now() WHERE principal_kind='agent' AND principal_id=$1 AND revoked_at IS NULL", [agentId]);
  }

  async userActive(id: string, q: Queryable = this.db): Promise<boolean> {
    const { rows } = await q.query(`${MEMBERS_SQL} AND u.id = $2`, [this.orgId, id]);
    return !!rows[0] && !rows[0].disabled_at;
  }

  /** Rebuild an actor from its audit reference; a person's owner flag is read from their current membership. */
  async parseActorRef(ref: string): Promise<Actor> {
    const [kind, id] = ref.split(":") as [string, string];
    if (kind !== "human") return { kind: "agent", id };
    const { rows } = await this.db.query("SELECT is_owner FROM org_members WHERE org_id=$1 AND user_id=$2", [this.orgId, id]);
    return { kind: "human", id, owner: !!rows[0]?.is_owner };
  }
}
