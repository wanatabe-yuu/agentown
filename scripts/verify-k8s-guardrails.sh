#!/usr/bin/env bash
# Verifies the cluster-side guard rails *as the controller ServiceAccount*:
# what the Agentown server itself could do if it were compromised or buggy.
# Uses server-side dry-run so admission (PSA + ValidatingAdmissionPolicy) runs
# for real without scheduling anything.
#
#   KUBECONFIG_CONTROLLER=.agentown/controller.kubeconfig scripts/verify-k8s-guardrails.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KCFG="${KUBECONFIG_CONTROLLER:-$ROOT/.agentown/controller.kubeconfig}"
KUBECTL="${KUBECTL:-kubectl}"
NS="${NS:-agentown-eng}"
IMAGE="${IMAGE:-agentown/harness:$(node -p "require('$ROOT/package.json').version")}"
k() { "$KUBECTL" --kubeconfig "$KCFG" "$@"; }

pass=0
fail=0
expect() { # expect allow|deny[:reason-regex] "description" cmd...
  local want="${1%%:*}" reason="" desc="$2"
  [[ "$1" == *:* ]] && reason="${1#*:}"
  shift 2
  local out
  if out="$("$@" 2>&1)"; then got=allow; else got=deny; fi
  # A denial only counts if it is denied for the reason under test.
  if [ "$got" = deny ] && [ -n "$reason" ] && ! grep -qE "$reason" <<<"$out"; then got="deny(other)"; fi
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
    printf 'ok    %-5s %s\n' "$want" "$desc"
  else
    fail=$((fail + 1))
    printf 'FAIL  want %-5s got %-5s %s\n      %s\n' "$want" "$got" "$desc" "$(echo "$out" | tail -n1)"
  fi
}

# A pod shaped exactly like KubernetesDriver.createPod, with optional overrides.
pod() { # pod NAME [jq-ish patch via sed placeholders]
  local name="$1" image="${2:-$IMAGE}" automount="${3:-false}" sa="${4:-agent-x1}" extra_vol="${5:-}" privileged="${6:-false}"
  cat <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $name
  namespace: $NS
  labels: { app.kubernetes.io/managed-by: agentown, agentown.io/agent: x1, agentown.io/generation: "1" }
spec:
  serviceAccountName: $sa
  automountServiceAccountToken: $automount
  securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
  containers:
  - name: harness
    image: $image
    securityContext: { allowPrivilegeEscalation: $privileged, privileged: $privileged, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
    resources: { requests: { cpu: 250m, memory: 256Mi }, limits: { cpu: 250m, memory: 256Mi } }
    volumeMounts: [ { name: workspace, mountPath: /workspace } ]
  volumes:
  - name: workspace
    emptyDir: {}
$extra_vol
EOF
}

create() { k create --dry-run=server -f - ; }

echo "== RBAC (controller ServiceAccount)"
expect deny "create RoleBinding in agent namespace" k auth can-i create rolebindings -n "$NS" --quiet
expect deny "create ClusterRoleBinding" k auth can-i create clusterrolebindings --quiet
expect deny "edit the admission policy" k auth can-i update validatingadmissionpolicies --quiet
expect deny "list pods in kube-system" k auth can-i list pods -n kube-system --quiet
expect deny "read secrets in kube-system" k auth can-i get secrets -n kube-system --quiet
expect deny "create pods in default namespace" k auth can-i create pods -n default --quiet
expect deny "create nodes/proxy" k auth can-i create nodes/proxy --quiet
expect deny "list secrets in agent namespace (get-by-name only)" k auth can-i list secrets -n "$NS" --quiet
expect allow "create pods in agent namespace" k auth can-i create pods -n "$NS" --quiet
expect allow "exec into pods in agent namespace" k auth can-i create pods/exec -n "$NS" --quiet

echo "== Admission (ValidatingAdmissionPolicy + Pod Security restricted)"
# Real ServiceAccounts so denials below are about policy, not missing objects.
k -n "$NS" create serviceaccount agent-x1 >/dev/null 2>&1 || true
k -n "$NS" create serviceaccount agent-x2 >/dev/null 2>&1 || true
trap 'k -n "$NS" delete serviceaccount agent-x1 agent-x2 >/dev/null 2>&1' EXIT
expect allow "pod shaped like the runtime driver" create < <(pod ok-pod)
expect "deny:approved runtime catalog" "image outside the runtime catalog" create < <(pod bad-image busybox:1.36)
# (the injected projected token volume trips the volume rule first; either way: no token)
expect "deny:must not receive a Kubernetes API token|workspace volume and emptyDir" "Kubernetes API token mounted" create < <(pod bad-token "$IMAGE" true)
expect "deny:per-agent ServiceAccount" "foreign ServiceAccount (default)" create < <(pod bad-sa "$IMAGE" false default)
expect "deny:must match the agent" "ServiceAccount of another agent" create < <(pod other-sa "$IMAGE" false agent-x2)
expect "deny:workspace volume and emptyDir|hostPath" "hostPath mount" create < <(pod bad-hostpath "$IMAGE" false agent-x1 "  - { name: host, hostPath: { path: / } }")
expect "deny:privileged|PodSecurity" "privileged container" create < <(pod bad-priv "$IMAGE" false agent-x1 "" true)
expect "deny:host namespaces|hostNetwork" "hostNetwork" create < <(pod bad-hostnet | sed 's/^spec:/spec:\n  hostNetwork: true/')

echo
echo "passed: $pass  failed: $fail"
[ "$fail" = 0 ]
