import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
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
import { type RemotePort, remoteListener, remoteTls, stunPublicIp } from "./remote-port.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const env = process.env;
// Release installs keep mutable state outside the read-only release directory.
const stateDir = env.AGENTOWN_STATE_DIR ?? resolve(root, ".agentown");

const configText = readFileSync(env.AGENTOWN_CONFIG ?? resolve(root, "config/agentown.yaml"), "utf8");
const db = createPool(env.DATABASE_URL ?? "postgres://agentown:agentown@127.0.0.1:5432/agentown");
await migrate(db);

const bus = new EventBus();
const secrets = SecretBox.fromEnvOrFile(env.AGENTOWN_SECRET_KEY, resolve(stateDir, "secret-key"));
// Where new worlds come from (off: only the built-in one and uploaded files).
const marketplace = env.AGENTOWN_MARKETPLACE === "off" ? null : { indexUrl: env.AGENTOWN_MARKETPLACE ?? "https://raw.githubusercontent.com/wanatabe-yuu/agentown-marketplace/main/index.json" };
const instance = new Instance(db, configText, bus, secrets, listModels, env.AGENTOWN_TEMPLATES ?? resolve(root, "config/templates"), marketplace);
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

const runtimeApiUrl = env.AGENTOWN_RUNTIME_API_URL ?? (driverKind === "docker" ? "http://host.docker.internal:8080" : "http://172.17.0.1:8080");
const controller = driver
  ? new RuntimeController(instance, driver, {
      apiUrlForRuntimes: runtimeApiUrl,
      log: (msg, extra) => console.log(`[controller] ${msg}`, extra ?? ""),
    })
  : null;

// Paired machines reach this server directly on a port of its own (AGENTOWN_REMOTE_PORT, off: none).
const port = Number(env.PORT ?? 8080);
let remote: RemotePort | null = null;
let remoteServer: Awaited<ReturnType<typeof remoteListener>> | null = null;
if (env.AGENTOWN_REMOTE_PORT !== "off") {
  try {
    const tls = remoteTls(resolve(stateDir, "remote"));
    const r: RemotePort = { port: Number(env.AGENTOWN_REMOTE_PORT ?? 7443), pin: tls.pin, publicHost: env.AGENTOWN_PUBLIC_HOST ?? null };
    const pair = (req: IncomingMessage, res: ServerResponse) => (instance.computers ? void instance.computers.servePair(req, res, `https://${req.headers.host}`) : res.writeHead(503).end());
    remoteServer = await remoteListener({ port: r.port, target: port, key: tls.key, cert: tls.cert, pair });
    remote = r;
    // Its public address, if it has one: stated, or asked once (STUN tells only the address).
    if (!r.publicHost) void stunPublicIp().then((ip) => (r.publicHost = ip));
    console.log(`[agentown] paired machines connect directly on :${r.port} (key pin ${r.pin})`);
  } catch (err) {
    console.warn(`[agentown] no direct port for paired machines (${(err as Error).message}); they connect through this server's own address`);
  }
}

const { app, recheckTerminals, cleanup, calendar } = await buildApp({
  instance,
  driver,
  webDist: env.AGENTOWN_WEB_DIST ?? resolve(root, "apps/web/dist"),
  logger: env.AGENTOWN_LOG === "1",
  onStateChange: () => void controller?.reconcileAll(),
  runtimeApiUrl,
  remote,
  // Pairing links on a temporary address when cloudflared is here (AGENTOWN_PAIR_TUNNEL=off: this server's own address).
  cloudflared: env.AGENTOWN_PAIR_TUNNEL === "off" ? null : [env.AGENTOWN_PAIR_TUNNEL, ...(env.PATH ?? "").split(":").map((d) => `${d}/cloudflared`), "/usr/local/bin/cloudflared", "/usr/bin/cloudflared"].find((p) => p && existsSync(p)),
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
    const { rows } = await db.query<{ org_id: string }>("SELECT DISTINCT c.org_id FROM campaigns c JOIN organizations o ON o.id=c.org_id AND o.paused_at IS NULL WHERE c.mode='auto' AND c.status='active'");
    for (const r of rows) await (await instance.org(r.org_id)).driveCampaigns();
    // Questions nobody answered in time go back to their agents with leave to decide.
    const asked = await db.query<{ org_id: string }>("SELECT DISTINCT p.org_id FROM proposals p JOIN organizations o ON o.id=p.org_id AND o.paused_at IS NULL WHERE p.kind='question' AND p.status='pending' AND (p.payload->>'deadline')::timestamptz < now()");
    for (const r of asked.rows) await (await instance.org(r.org_id)).expireQuestions();
  })()
    .catch((err) => console.warn("[campaigns]", (err as Error).message))
    .finally(() => (driving = null));
};
const campaignSweep = setInterval(driveCampaigns, 15000);
// Cleaning robots and trash cans whose time has come (checked every minute).
const cleanupSweep = setInterval(() => void cleanup.tick().catch((err) => console.warn("[cleanup]", (err as Error).message)), 60_000);
const calendarTick = setInterval(() => void calendar.tick().catch((err) => console.warn("[calendar]", (err as Error).message)), 60_000);
// Pausing organizations stop once their runs have finished.
const pauseSweep = setInterval(() => void instance.settlePausing().catch((err) => console.warn("[pause]", (err as Error).message)), 5000);
bus.subscribe((e) => {
  if (e.type === "task.status") setTimeout(driveCampaigns, 500);
});

if (controller) controller.start();
const leaseSweep = !controller ? setInterval(() => void instance.sweepLeases().catch(() => {}), 5000) : null;

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
  clearInterval(pauseSweep);
  clearInterval(cleanupSweep);
  clearInterval(calendarTick);
  if (leaseSweep) clearInterval(leaseSweep);
  remoteServer?.close();
  await app.close();
  await db.end();
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown().catch(() => process.exit(1)));
