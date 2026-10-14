/**
 * Checks dedicated-node scheduling against a live cluster (as the controller SA):
 * two agents on the dedicated preset must land on *different* dedicated nodes,
 * and with fewer dedicated nodes than agents the extra one stays Pending
 * (Unschedulable) instead of sharing a node.
 *
 *   AGENTOWN_KUBECONFIG=.agentown/controller.kubeconfig tsx apps/server/src/tools/k8s-placement-check.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as k8s from "@kubernetes/client-node";
import { parseOrgConfig } from "@agentown/core";
import { KubernetesDriver } from "../runtime/kubernetes.ts";

const config = parseOrgConfig(readFileSync(resolve(import.meta.dirname, "../../../../config/agentown.yaml"), "utf8"));
const preset = config.runtimeCatalog.find((p) => p.placement === "dedicated-node");
if (!preset) throw new Error("no dedicated-node preset in config");
const kc = new k8s.KubeConfig();
kc.loadFromFile(process.env.AGENTOWN_KUBECONFIG!);
const core = kc.makeApiClient(k8s.CoreV1Api);
const driver = new KubernetesDriver(process.env.AGENTOWN_KUBECONFIG);
const ns = "agentown-eng";
const ids = ["place-a", "place-b"].map((x) => `${x}-${Date.now().toString(36)}`);

for (const agentId of ids) {
  const spec = { agentId, generation: 1, namespace: ns, preset, apiUrl: "http://127.0.0.1:8080", storageRef: `agent-${agentId}-workspace`, displayName: agentId, jobRole: "engineer", llm: null };
  await driver.ensureIdentity(spec, async () => "placement-token");
  await driver.createPod(spec);
}
await new Promise((r) => setTimeout(r, 12000));
for (const agentId of ids) {
  const pod = await core.readNamespacedPod({ name: `agent-${agentId}-g1`, namespace: ns });
  const sched = pod.status?.conditions?.find((c) => c.type === "PodScheduled");
  console.log(`${agentId}: node=${pod.spec?.nodeName ?? "-"} scheduled=${sched?.status} ${sched?.reason ?? ""} ${(sched?.message ?? "").slice(0, 120)}`);
}
if (process.env.AGENTOWN_KEEP) process.exit(0);
for (const agentId of ids) {
  await driver.deletePod(ns, `agent-${agentId}-g1`);
  await driver.teardown(ns, agentId, true);
}
