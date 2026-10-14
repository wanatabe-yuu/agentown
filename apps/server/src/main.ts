import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOrgConfig } from "@agentown/core";
import { buildApp } from "./app.ts";
import { EventBus } from "./bus.ts";
import { createPool, migrate } from "./db.ts";
import { RuntimeController } from "./runtime/controller.ts";
import type { RuntimeDriver } from "./runtime/driver.ts";
import { DockerDriver } from "./runtime/docker.ts";
import { KubernetesDriver } from "./runtime/kubernetes.ts";
import { listModels } from "./providers.ts";
import { SecretBox } from "./secrets.ts";
import { Service } from "./service.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const env = process.env;

const config = parseOrgConfig(readFileSync(env.AGENTOWN_CONFIG ?? resolve(root, "config/agentown.yaml"), "utf8"));
const db = createPool(env.DATABASE_URL ?? "postgres://agentown:agentown@127.0.0.1:5432/agentown");
await migrate(db);

const bus = new EventBus();
const secrets = SecretBox.fromEnvOrFile(env.AGENTOWN_SECRET_KEY, resolve(root, ".agentown/secret-key"));
const service = new Service(db, config, bus, secrets, listModels);
const { ownerToken } = await service.bootstrap({ ownerToken: env.AGENTOWN_OWNER_TOKEN });
if (ownerToken && !env.AGENTOWN_OWNER_TOKEN) {
  const stateDir = resolve(root, ".agentown");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(resolve(stateDir, "owner-token"), `${ownerToken}\n`, { mode: 0o600 });
  console.log(`[agentown] owner token written to .agentown/owner-token (shown once)`);
}

const driverKind = env.AGENTOWN_RUNTIME_DRIVER ?? "kubernetes";
let driver: RuntimeDriver | null = null;
if (driverKind === "kubernetes") driver = new KubernetesDriver(env.AGENTOWN_KUBECONFIG);
else if (driverKind === "docker") driver = new DockerDriver(resolve(root, ".agentown/runtime-secrets"));
else if (driverKind !== "none") throw new Error(`unknown AGENTOWN_RUNTIME_DRIVER ${driverKind}`);

const controller = driver
  ? new RuntimeController(service, driver, {
      apiUrlForRuntimes:
        env.AGENTOWN_RUNTIME_API_URL ?? (driverKind === "docker" ? "http://host.docker.internal:8080" : "http://172.17.0.1:8080"),
      log: (msg, extra) => console.log(`[controller] ${msg}`, extra ?? ""),
    })
  : null;

const { app, recheckTerminals } = await buildApp({
  service,
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
setInterval(() => void recheckTerminals().catch(() => {}), 5000);

if (controller) controller.start();
else setInterval(() => void service.sweepLeases().catch(() => {}), 5000);

const port = Number(env.PORT ?? 8080);
await app.listen({ port, host: env.HOST ?? "0.0.0.0" });
console.log(`[agentown] listening on :${port} (runtime driver: ${driverKind})`);
