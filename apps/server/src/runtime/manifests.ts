import { stringify } from "yaml";

/** Names the provisioner will create; anything else coming from the database is skipped. */
export const NAMESPACE_NAME = /^agentown-[a-z0-9]([a-z0-9-]{0,52}[a-z0-9])?$/;

export interface AgentNamespace {
  name: string;
  labels: Record<string, string>;
}

/**
 * Cluster-side guard rails for the given agent namespaces:
 *   - each namespace runs Pod Security "restricted",
 *   - a namespaced Role for the controller (no cluster-wide rights),
 *   - default-deny NetworkPolicy (egress only to DNS, the Agentown API and public HTTPS),
 *   - a ResourceQuota,
 *   - one ValidatingAdmissionPolicy rejecting any pod in agent namespaces that
 *     isn't shaped like ours (image allowlist from the install catalog, no host
 *     access, no SA token).
 * Pure: the caller decides the namespaces and images.
 */
export function renderManifests(opts: { images: string[]; namespaces: AgentNamespace[]; apiCidr: string; apiPort: number }): string {
  const { apiCidr, apiPort } = opts;
  const images = [...new Set(opts.images)];
  const namespaces = opts.namespaces.filter((n) => NAMESPACE_NAME.test(n.name));
  const docs: unknown[] = [
    { apiVersion: "v1", kind: "Namespace", metadata: { name: "agentown-system" } },
    { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "agentown-controller", namespace: "agentown-system" } },
  ];

  for (const { name: ns, labels } of namespaces) {
    docs.push(
      {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: ns,
          labels: {
            ...labels,
            "agentown.io/managed": "true",
            "pod-security.kubernetes.io/enforce": "restricted",
            "pod-security.kubernetes.io/enforce-version": "latest",
          },
        },
      },
      {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "Role",
        metadata: { name: "agentown-controller", namespace: ns },
        rules: [
          { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch", "create", "delete"] },
          { apiGroups: [""], resources: ["pods/exec"], verbs: ["get", "create"] },
          { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
          { apiGroups: [""], resources: ["persistentvolumeclaims"], verbs: ["get", "list", "create", "delete"] },
          { apiGroups: [""], resources: ["secrets"], verbs: ["get", "create", "delete"] },
          { apiGroups: [""], resources: ["serviceaccounts"], verbs: ["get", "create", "delete"] },
        ],
      },
      {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "RoleBinding",
        metadata: { name: "agentown-controller", namespace: ns },
        roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "agentown-controller" },
        subjects: [{ kind: "ServiceAccount", name: "agentown-controller", namespace: "agentown-system" }],
      },
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "agent-isolation", namespace: ns },
        spec: {
          podSelector: {},
          policyTypes: ["Ingress", "Egress"],
          ingress: [], // no agent accepts connections, not even from its own department
          egress: [
            {
              to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }],
              ports: [
                { protocol: "UDP", port: 53 },
                { protocol: "TCP", port: 53 },
              ],
            },
            { to: [{ ipBlock: { cidr: apiCidr } }], ports: [{ protocol: "TCP", port: apiPort }] },
            // LLM provider egress (only matters for runtimes using the LLM harness): public HTTPS only.
            {
              to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"] } }],
              ports: [{ protocol: "TCP", port: 443 }],
            },
          ],
        },
      },
      {
        apiVersion: "v1",
        kind: "ResourceQuota",
        metadata: { name: "agentown-quota", namespace: ns },
        // Room for a few teams and the world's computers (each up to 1 CPU / 2Gi while on).
        spec: { hard: { pods: "30", "requests.cpu": "4", "requests.memory": "8Gi", "limits.cpu": "8", "limits.memory": "8Gi", persistentvolumeclaims: "40" } },
      },
    );
  }

  const imageList = images.map((i) => `'${i}'`).join(", ");
  docs.push(
    {
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "ValidatingAdmissionPolicy",
      metadata: { name: "agentown-runtime-guard" },
      spec: {
        failurePolicy: "Fail",
        matchConstraints: {
          resourceRules: [{ apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE", "UPDATE"], resources: ["pods"] }],
        },
        validations: [
          {
            expression: "object.spec.containers.all(c, (!has(c.envFrom) || size(c.envFrom) == 0) && (!has(c.env) || c.env.all(e, !(e.name in ['ANTHROPIC_API_KEY', 'AGENTOWN_LLM_API_KEY']) && (!has(e.valueFrom) || !has(e.valueFrom.secretKeyRef) || (e.name == 'AGENTOWN_TOKEN' && e.valueFrom.secretKeyRef.key == 'token' && e.valueFrom.secretKeyRef.name == 'agent-' + object.metadata.labels['agentown.io/agent'] + '-credentials')))))",
            message: "provider API keys must stay on the server; only the agent identity token may be mounted",
          },
          {
            expression: `object.spec.containers.all(c, c.image in [${imageList}])`,
            message: "agent runtimes may only use images from the approved runtime catalog",
          },
          {
            expression: "!has(object.spec.initContainers) && !has(object.spec.ephemeralContainers)",
            message: "init/ephemeral containers are not allowed in agent runtimes",
          },
          {
            expression: "!has(object.spec.volumes) || object.spec.volumes.all(v, has(v.persistentVolumeClaim) || has(v.emptyDir))",
            message: "agent runtimes may only mount their workspace volume and emptyDir",
          },
          {
            expression:
              "(!has(object.spec.hostNetwork) || !object.spec.hostNetwork) && (!has(object.spec.hostPID) || !object.spec.hostPID) && (!has(object.spec.hostIPC) || !object.spec.hostIPC)",
            message: "host namespaces are not allowed",
          },
          {
            expression: "has(object.spec.automountServiceAccountToken) && object.spec.automountServiceAccountToken == false",
            message: "agent runtimes must not receive a Kubernetes API token",
          },
          {
            expression: "has(object.spec.serviceAccountName) && object.spec.serviceAccountName.startsWith('agent-')",
            message: "agent runtimes must run as their own per-agent ServiceAccount",
          },
          {
            expression: "has(object.metadata.labels) && 'agentown.io/agent' in object.metadata.labels && object.spec.serviceAccountName == 'agent-' + object.metadata.labels['agentown.io/agent']",
            message: "pod ServiceAccount must match the agent it runs",
          },
        ],
      },
    },
    {
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "ValidatingAdmissionPolicyBinding",
      metadata: { name: "agentown-runtime-guard" },
      spec: {
        policyName: "agentown-runtime-guard",
        validationActions: ["Deny"],
        matchResources: { namespaceSelector: { matchLabels: { "agentown.io/managed": "true" } } },
      },
    },
  );
  return docs.map((d) => stringify(d)).join("---\n");
}
