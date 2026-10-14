/**
 * Print the cluster guard rails (see runtime/manifests.ts) for kubectl apply.
 * This is the provisioner: it runs with cluster-admin (install timer, dev-k3s.sh),
 * never inside the server, which holds no cluster-scoped rights.
 *
 * Namespaces: one per department of the config file's organization (the layout
 * from before multi-org) plus, when DATABASE_URL is set, every active
 * organization's namespace and any namespace a live runtime still uses.
 * Images always come from the config file's runtime catalog.
 *
 * Usage: tsx apps/server/src/tools/render-manifests.ts > /tmp/agentown.yaml
 * Env: AGENTOWN_CONFIG, DATABASE_URL, AGENTOWN_API_CIDR (e.g. 172.17.0.1/32), AGENTOWN_API_PORT (8080)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseOrgConfig } from "@agentown/core";
import pg from "pg";
import { type AgentNamespace, renderManifests } from "../runtime/manifests.ts";

const cfgPath = process.env.AGENTOWN_CONFIG ?? resolve(import.meta.dirname, "../../../../config/agentown.yaml");
const config = parseOrgConfig(readFileSync(cfgPath, "utf8"));

const namespaces = new Map<string, AgentNamespace>();
for (const d of config.departments) {
  namespaces.set(`agentown-${d.id}`, { name: `agentown-${d.id}`, labels: { "agentown.io/org": config.organization.id, "agentown.io/department": d.id } });
}
if (process.env.DATABASE_URL) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const { rows } = await client.query<{ name: string; org: string }>(
      `SELECT runtime_namespace AS name, id AS org FROM organizations WHERE archived_at IS NULL AND runtime_namespace IS NOT NULL
       UNION
       SELECT DISTINCT r.namespace, a.org_id FROM agent_runtimes r JOIN agents a ON a.id = r.agent_id WHERE a.lifecycle_state <> 'retired'`,
    );
    for (const r of rows) if (!namespaces.has(r.name)) namespaces.set(r.name, { name: r.name, labels: { "agentown.io/org": r.org } });
  } catch (err) {
    // First install: the server may not have created its schema yet.
    process.stderr.write(`render-manifests: database not read (${(err as Error).message}); config namespaces only\n`);
  } finally {
    await client.end().catch(() => {});
  }
}

process.stdout.write(
  renderManifests({
    images: config.runtimeCatalog.map((p) => p.image),
    namespaces: [...namespaces.values()],
    apiCidr: process.env.AGENTOWN_API_CIDR ?? "172.17.0.1/32",
    apiPort: Number(process.env.AGENTOWN_API_PORT ?? 8080),
  }),
);
