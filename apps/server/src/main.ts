import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.ts";
import { EventBus } from "./bus.ts";
import { createPool, migrate } from "./db.ts";
import { RuntimeController } from "./runtime/controller.ts";
import type { RuntimeDriver } from "./runtime/driver.ts";
import { DockerDriver } from "./runtime/docker.ts";
import { KubernetesDriver } from "./runtime/kubernetes.ts";
import { listModels } from "./providers.ts";
import { SecretBox } from "./secrets.ts";
import { Instance } from "./instance.ts";
import { collectResults } from "./selfpatch.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const env = process.env;
// Release installs keep mutable state outside the read-only release directory.
const stateDir = env.AGENTOWN_STATE_DIR ?? resolve(root, ".agentown");

const configText = readFileSync(env.AGENTOWN_CONFIG ?? resolve(root, "config/agentown.yaml"), "utf8");
const db = createPool(env.DATABASE_URL ?? "postgres://agentown:agentown@127.0.0.1:5432/agentown");
await migrate(db);

const bus = new EventBus();
const secrets = SecretBox.fromEnvOrFile(env.AGENTOWN_SECRET_KEY, resolve(stateDir, "secret-key"));
const instance = new Instance(db, configText, bus, secrets, listModels, env.AGENTOWN_TEMPLATES ?? resolve(root, "config/templates"));
const { ownerToken } = await instance.bootstrap({ ownerToken: env.AGENTOWN_OWNER_TOKEN });
if (ownerToken && !env.AGENTOWN_OWNER_TOKEN) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(resolve(stateDir, "owner-token"), `${ownerToken}\n`, { mode: 0o600 });
  console.log(`[agentown] owner token written to ${resolve(stateDir, "owner-token")} (shown once)`);
}

const driverKind = env.AGENTOWN_RUNTIME_DRIVER ?? "kubernetes";
let driver: RuntimeDriver | null = null;
if (driverKind === "kubernetes") driver = new KubernetesDriver(env.AGENTOWN_KUBECONFIG);
else if (driverKind === "docker") driver = new DockerDriver(resolve(stateDir, "runtime-secrets"));
else if (driverKind !== "none") throw new Error(`unknown AGENTOWN_RUNTIME_DRIVER ${driverKind}`);

const controller = driver
  ? new RuntimeController(instance, driver, {
      apiUrlForRuntimes:
        env.AGENTOWN_RUNTIME_API_URL ?? (driverKind === "docker" ? "http://host.docker.internal:8080" : "http://172.17.0.1:8080"),
      log: (msg, extra) => console.log(`[controller] ${msg}`, extra ?? ""),
    })
  : null;

const { app, recheckTerminals } = await buildApp({
  instance,
  driver,
  webDist: env.AGENTOWN_WEB_DIST ?? resolve(root, "apps/web/dist"),
  logger: env.AGENTOWN_LOG === "1",
  onStateChange: () => void controller?.reconcileAll(),
});

// Policy, graph or runtime changes can invalidate an open terminal: re-check promptly.
const RECHECK_ON = new Set(["grant.revoked", "agent.updated", "agent.retired", "runtime.generation", "runtime.state"]);
bus.subscribe((e) => {
  if (RECHECK_ON.has(e.type)) void recheckTerminals().catch(() => {});
});
const terminalSweep = setInterval(() => void recheckTerminals().catch(() => {}), 5000);
// The host's self-patch builder leaves results; put them on their proposals.
const patchSweep = setInterval(() => void collectResults(db).catch(() => {}), 10000);
// Auto campaigns take their next step once their tasks settle: right after a task changes, and every 15 s.
let driving: Promise<void> | null = null;
const driveCampaigns = () => {
  driving ??= (async () => {
    const { rows } = await db.query<{ org_id: string }>("SELECT DISTINCT org_id FROM campaigns WHERE mode='auto' AND status='active'");
    for (const r of rows) await (await instance.org(r.org_id)).driveCampaigns();
    // Questions nobody answered in time go back to their agents with leave to decide.
    const asked = await db.query<{ org_id: string }>("SELECT DISTINCT org_id FROM proposals WHERE kind='question' AND status='pending' AND (payload->>'deadline')::timestamptz < now()");
    for (const r of asked.rows) await (await instance.org(r.org_id)).expireQuestions();
  })()
    .catch((err) => console.warn("[campaigns]", (err as Error).message))
    .finally(() => (driving = null));
};
const campaignSweep = setInterval(driveCampaigns, 15000);
bus.subscribe((e) => {
  if (e.type === "task.status") setTimeout(driveCampaigns, 500);
});

if (controller) controller.start();
const leaseSweep = !controller ? setInterval(() => void instance.sweepLeases().catch(() => {}), 5000) : null;

const port = Number(env.PORT ?? 8080);
await app.listen({ port, host: env.HOST ?? "0.0.0.0" });
console.log(`[agentown] listening on :${port} (runtime driver: ${driverKind})`);

// Finish private chat receipts before exiting; clients reconnect to persisted history.
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  controller?.stop();
  clearInterval(terminalSweep);
  clearInterval(patchSweep);
  clearInterval(campaignSweep);
  if (leaseSweep) clearInterval(leaseSweep);
  await app.close();
  await db.end();
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown().catch(() => process.exit(1)));
