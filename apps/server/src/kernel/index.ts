import type { OrgConfig } from "@agentown/core";
import type { Queryable } from "../db.ts";
import type { SecretBox } from "../secrets.ts";
import { Identity } from "./identity.ts";
import { Permissions } from "./permissions.ts";
import { Resources } from "./resources.ts";
import { Rules } from "./rules.ts";

/**
 * World Kernel: the organization's ground truth — its rules (structure),
 * identities, resources and permissions. Everything else (tasks, runtimes,
 * conversations, the capability gateway, proposals) is built on it; the kernel
 * depends on none of them, and knows nothing about where agents run.
 */
export class Kernel {
  readonly rules: Rules;
  readonly permissions: Permissions;
  readonly identity: Identity;
  readonly resources: Resources;

  constructor(db: Queryable, config: OrgConfig, readonly orgId: string, secrets: SecretBox) {
    this.rules = new Rules(config);
    this.permissions = new Permissions(db, orgId);
    this.identity = new Identity(db, orgId, this.permissions);
    this.resources = new Resources(db, config, orgId, secrets);
  }
}

export type { LoadedPolicy, GrantRow } from "./permissions.ts";
export { toGrant } from "./permissions.ts";
export { MEMBERS_SQL } from "./identity.ts";
export type { CredentialRow, ModelConnection, Share } from "./resources.ts";
export { parseShare } from "./resources.ts";
