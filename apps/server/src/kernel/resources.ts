import { type ApiProtocol, type AuthHeader, apiProtocol, cpuMillis, defaultAuthHeader, memoryMib, type OrgConfig, type RuntimePreset } from "@agentown/core";
import type { Queryable } from "../db.ts";
import { type Provider, providerBaseUrl } from "../providers.ts";
import type { SecretBox } from "../secrets.ts";
import { badRequest, notFound } from "../util.ts";

/**
 * Resources: what the organization has to work with — model credentials (keys
 * sealed with the instance secret, never handed out), runtime presets, and the
 * compute share each member declares.
 */

export interface CredentialRow {
  id: string;
  name: string;
  provider: Provider;
  ciphertext: Buffer;
  key_hint: string;
  workspace_id: string | null;
  base_url: string | null;
  api_protocol: ApiProtocol | null;
  auth_header: AuthHeader | null;
  models: string[];
  departments: string[] | null;
  revision: number;
  created_by: string;
  created_at: Date;
  models_refreshed_at: Date;
  revoked_at: Date | null;
}

/** Non-secret description of a model connection (what a runtime may know). */
export interface ModelConnection {
  provider: string;
  workspaceId: string | null;
  baseUrl: string | null;
  protocol?: ApiProtocol;
  authHeader?: AuthHeader;
}

/** Resource share in millicores / MiB. */
export interface Share {
  cpu: number;
  memory: number;
}

export class Resources {
  constructor(
    private readonly db: Queryable,
    private readonly config: OrgConfig,
    private readonly orgId: string,
    private readonly secrets: SecretBox,
  ) {}

  preset(id: string | null | undefined): RuntimePreset | undefined {
    return this.config.runtimeCatalog.find((p) => p.id === id);
  }

  async credential(id: string, q: Queryable = this.db): Promise<CredentialRow> {
    const { rows } = await q.query<CredentialRow>("SELECT * FROM credentials WHERE id=$1 AND org_id=$2", [id, this.orgId]);
    if (!rows[0]) throw notFound("credential");
    return rows[0];
  }

  /** Identifies a credential's current state: a runtime holding an older one must be refreshed. */
  async credentialRevision(credentialId: string | null, q: Queryable = this.db): Promise<string> {
    if (!credentialId) return "none";
    const cred = await this.credential(credentialId, q);
    return cred.revoked_at ? `${cred.id}:revoked` : `broker-v1:${cred.id}:${cred.revision}`;
  }

  connection(cred: CredentialRow): ModelConnection {
    return {
      provider: cred.provider,
      workspaceId: cred.workspace_id,
      baseUrl: providerBaseUrl(cred.provider, cred.base_url),
      ...(cred.provider === "custom" ? { protocol: apiProtocol(cred.provider, cred.api_protocol), authHeader: cred.auth_header ?? defaultAuthHeader(apiProtocol(cred.provider, cred.api_protocol)) } : {}),
    };
  }

  /** The key itself: only for the server's own outbound calls (model broker, chat). */
  openKey(cred: Pick<CredentialRow, "ciphertext">): string {
    return this.secrets.open(cred.ciphertext);
  }

  sealKey(apiKey: string): Buffer {
    return this.secrets.seal(apiKey);
  }

  /** A member's declared share of its team runtime (the preset's member default when undeclared). */
  memberShare(a: { cpu_millis: number | null; memory_mib: number | null }, preset: RuntimePreset): Share {
    return { cpu: a.cpu_millis ?? cpuMillis(preset.member.cpu), memory: a.memory_mib ?? memoryMib(preset.member.memory) };
  }

  /** The base share of a runtime of this preset. */
  baseShare(preset: RuntimePreset): Share {
    return { cpu: cpuMillis(preset.resources.cpu), memory: memoryMib(preset.resources.memory) };
  }
}

/** A declared share ("250m", "256Mi") in millicores / MiB, bounded. */
export function parseShare(input?: { cpu?: string; memory?: string }): Partial<Share> {
  const out: Partial<Share> = {};
  try {
    if (input?.cpu) out.cpu = cpuMillis(input.cpu);
    if (input?.memory) out.memory = memoryMib(input.memory);
  } catch (err) {
    throw badRequest((err as Error).message);
  }
  if (out.cpu !== undefined && (out.cpu < 10 || out.cpu > 64000)) throw badRequest("cpu must be between 10m and 64");
  if (out.memory !== undefined && (out.memory < 32 || out.memory > 262144)) throw badRequest("memory must be between 32Mi and 256Gi");
  return out;
}
