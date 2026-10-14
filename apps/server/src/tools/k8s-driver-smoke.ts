/**
 * Smoke-test KubernetesDriver against a live cluster as the controller SA:
 * identity objects + a runtime pod pass RBAC, Pod Security and admission.
 * Usage: AGENTOWN_KUBECONFIG=.agentown/controller.kubeconfig tsx apps/server/src/tools/k8s-driver-smoke.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseOrgConfig } from "@agentown/core";
import { classify } from "../runtime/controller.ts";
import { KubernetesDriver } from "../runtime/kubernetes.ts";

const config = parseOrgConfig(readFileSync(resolve(import.meta.dirname, "../../../../config/agentown.yaml"), "utf8"));
const driver = new KubernetesDriver(process.env.AGENTOWN_KUBECONFIG);
const agentId = `smoke-${Date.now().toString(36)}`;
const spec = {
  agentId,
  generation: 1,
  namespace: "agentown-eng",
  // Exercise the hardest shape: dedicated-node placement + a per-agent provider Secret.
  preset: config.runtimeCatalog.find((p) => p.placement === "dedicated-node") ?? config.runtimeCatalog[0]!,
  apiUrl: "http://127.0.0.1:8080",
  storageRef: `agent-${agentId}-workspace`,
  displayName: "Smoke",
  jobRole: "engineer",
  llm: { provider: "anthropic", workspaceId: "wrkspc_smoke", baseUrl: null },
};
let issued = 0;
await driver.ensureIdentity(spec, async () => {
  issued++;
  return "smoke-token";
});
await driver.ensureIdentity(spec, async () => {
  issued++;
  return "smoke-token";
});
console.log(`identity ensured twice, token issued ${issued} time(s)`);
const name = await driver.createPod(spec);
const pods = await driver.listPods(spec.namespace, agentId);
console.log(`created ${name}; listed ${pods.map((p) => `${p.name} g${p.generation} ${p.phase}`).join(", ")}; classified as ${JSON.stringify(classify(pods[0]!))}`);
await driver.deletePod(spec.namespace, name);
await driver.teardown(spec.namespace, agentId, true);
console.log("cleaned up");
