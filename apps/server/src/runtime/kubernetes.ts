import * as k8s from "@kubernetes/client-node";
import type { ExecStreams, PodInfo, RuntimeDriver, RuntimeSpec } from "./driver.ts";
import { NamespaceNotReady, podName } from "./driver.ts";

const MANAGED_BY = { "app.kubernetes.io/managed-by": "agentown" };
const CONTAINER = "harness";

function isStatus(err: unknown, code: number): boolean {
  return err instanceof k8s.ApiException && err.code === code;
}

async function ignore404(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (err) {
    if (!isStatus(err, 404)) throw err;
  }
}

async function createIfMissing(p: () => Promise<unknown>): Promise<boolean> {
  try {
    await p();
    return true;
  } catch (err) {
    if (isStatus(err, 409)) return false;
    throw err;
  }
}

/**
 * Kubernetes (k3s) driver. Runs with the `agentown-controller` ServiceAccount,
 * whose Role is limited to the agent namespaces (see deploy/k3s). Admission
 * policy in the cluster independently rejects pods that don't look like ours.
 */
export class KubernetesDriver implements RuntimeDriver {
  readonly kind = "kubernetes";
  private readonly core: k8s.CoreV1Api;
  private readonly execApi: k8s.Exec;

  constructor(kubeconfigPath?: string) {
    const kc = new k8s.KubeConfig();
    if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
    else kc.loadFromDefault();
    this.core = kc.makeApiClient(k8s.CoreV1Api);
    this.execApi = new k8s.Exec(kc);
  }

  async listPods(namespace: string, runtimeId: string): Promise<PodInfo[]> {
    let list;
    try {
      list = await this.core.listNamespacedPod({ namespace, labelSelector: `agentown.io/agent=${runtimeId}` });
    } catch (err) {
      // The controller holds Roles only in provisioned namespaces: 403 means "not provisioned yet".
      const code = (err as { code?: number; statusCode?: number }).code ?? (err as { statusCode?: number }).statusCode;
      if (code === 403 || code === 404) throw new NamespaceNotReady(namespace);
      throw err;
    }
    return list.items.map((p) => {
      const cs = p.status?.containerStatuses?.find((c) => c.name === CONTAINER);
      const waiting = cs?.state?.waiting;
      const terminated = cs?.state?.terminated ?? cs?.lastState?.terminated;
      const ready = p.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false;
      const scheduled = p.status?.conditions?.find((c) => c.type === "PodScheduled");
      return {
        name: p.metadata!.name!,
        generation: Number(p.metadata?.labels?.["agentown.io/generation"] ?? 0),
        phase: p.status?.phase ?? "Unknown",
        ready,
        terminating: !!p.metadata?.deletionTimestamp,
        restarts: cs?.restartCount ?? 0,
        waitingReason: waiting?.reason ?? (scheduled?.status === "False" ? scheduled.reason ?? "Unschedulable" : null),
        message: waiting?.message ?? scheduled?.message ?? terminated?.reason ?? p.status?.message ?? null,
      };
    });
  }

  async ensureIdentity(spec: RuntimeSpec, issueToken: () => Promise<string>): Promise<void> {
    const { namespace, runtimeId } = spec;
    const labels = { ...MANAGED_BY, "agentown.io/agent": runtimeId, "agentown.io/team": spec.teamId };
    await createIfMissing(() =>
      this.core.createNamespacedServiceAccount({
        namespace,
        body: {
          metadata: { name: `agent-${runtimeId}`, labels },
          // The runtime talks to the Agentown API with its own token, never to the Kubernetes API.
          automountServiceAccountToken: false,
        },
      }),
    );
    await createIfMissing(() =>
      this.core.createNamespacedPersistentVolumeClaim({
        namespace,
        body: {
          metadata: { name: spec.storageRef, labels },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: { requests: { storage: spec.preset.workspace.size } },
          },
        },
      }),
    );
    const secretName = `agent-${runtimeId}-credentials`;
    try {
      await this.core.readNamespacedSecret({ name: secretName, namespace });
    } catch (err) {
      if (!isStatus(err, 404)) throw err;
      const token = await issueToken();
      await this.core.createNamespacedSecret({
        namespace,
        body: { metadata: { name: secretName, labels }, type: "Opaque", stringData: { token } },
      });
    }
  }

  async createPod(spec: RuntimeSpec): Promise<string> {
    const name = podName(spec.runtimeId, spec.generation);
    const env: k8s.V1EnvVar[] = [
      { name: "AGENTOWN_API_URL", value: spec.apiUrl },
      { name: "AGENTOWN_TEAM_ID", value: spec.teamId },
      { name: "AGENTOWN_TEAM_GENERATION", value: String(spec.generation) },
      { name: "AGENTOWN_HARNESS", value: spec.preset.harness },
      { name: "AGENTOWN_DISPLAY_NAME", value: spec.displayName },
      { name: "AGENTOWN_TOKEN", valueFrom: { secretKeyRef: { name: `agent-${spec.runtimeId}-credentials`, key: "token" } } },
      { name: "HOME", value: "/workspace/home" },
    ];
    if (spec.preset.model) env.push({ name: "AGENTOWN_MODEL", value: spec.preset.model });
    const dedicated = spec.preset.placement === "dedicated-node";
    await createIfMissing(() =>
      this.core.createNamespacedPod({
        namespace: spec.namespace,
        body: {
          metadata: {
            name,
            labels: {
              ...MANAGED_BY,
              "agentown.io/agent": spec.runtimeId,
              "agentown.io/team": spec.teamId,
              "agentown.io/generation": String(spec.generation),
              "agentown.io/preset": spec.preset.id,
              "agentown.io/placement": spec.preset.placement,
              "agentown.io/harness": spec.preset.harness,
            },
          },
          spec: {
            serviceAccountName: `agent-${spec.runtimeId}`,
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            hostname: spec.runtimeId,
            restartPolicy: "Always",
            // dedicated-node: only on the dedicated pool, and never two dedicated agents on one node.
            ...(dedicated
              ? {
                  nodeSelector: { "agentown.io/pool": "dedicated" },
                  tolerations: [{ key: "agentown.io/dedicated", operator: "Exists", effect: "NoSchedule" }],
                  affinity: {
                    podAntiAffinity: {
                      requiredDuringSchedulingIgnoredDuringExecution: [
                        {
                          topologyKey: "kubernetes.io/hostname",
                          namespaceSelector: {},
                          labelSelector: { matchLabels: { "agentown.io/placement": "dedicated-node" } },
                        },
                      ],
                    },
                  },
                }
              : {}),
            terminationGracePeriodSeconds: 10,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              fsGroup: 1000,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: CONTAINER,
                image: spec.preset.image,
                imagePullPolicy: spec.preset.imagePullPolicy,
                env,
                resources: {
                  // A computer idles most of the time: it reserves little CPU and bursts up to its limit.
                  requests: { cpu: spec.preset.harness === "browser" ? "50m" : spec.resources.cpu, memory: spec.resources.memory },
                  limits: { cpu: spec.resources.cpu, memory: spec.resources.memory },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
                volumeMounts: [
                  { name: "workspace", mountPath: "/workspace" },
                  { name: "tmp", mountPath: "/tmp" },
                ],
              },
            ],
            volumes: [
              { name: "workspace", persistentVolumeClaim: { claimName: spec.storageRef } },
              { name: "tmp", emptyDir: { sizeLimit: "256Mi" } },
            ],
          },
        },
      }),
    );
    return name;
  }

  async deletePod(namespace: string, name: string): Promise<void> {
    await ignore404(this.core.deleteNamespacedPod({ name, namespace, gracePeriodSeconds: 5 }));
  }

  async teardown(namespace: string, runtimeId: string, purgeWorkspace: boolean): Promise<void> {
    await ignore404(this.core.deleteNamespacedSecret({ name: `agent-${runtimeId}-credentials`, namespace }));
    await ignore404(this.core.deleteNamespacedSecret({ name: `agent-${runtimeId}-provider`, namespace }));
    await ignore404(this.core.deleteNamespacedServiceAccount({ name: `agent-${runtimeId}`, namespace }));
    if (purgeWorkspace) {
      await ignore404(this.core.deleteNamespacedPersistentVolumeClaim({ name: `agent-${runtimeId}-workspace`, namespace }));
    }
  }

  async exec(namespace: string, pod: string, command: string[], streams: ExecStreams) {
    const ws = await this.execApi.exec(namespace, pod, CONTAINER, command, streams.stdout, null, streams.stdin, true, (s) =>
      streams.onExit({ status: s.status, message: s.message }),
    );
    return { close: () => ws.close() };
  }
}
