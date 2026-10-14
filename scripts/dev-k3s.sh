#!/usr/bin/env bash
# Local single-machine cluster for Agentown: k3s running in a Docker container.
# On a real Linux host you can install k3s natively instead and only run the
# "apply" and "controller kubeconfig" steps below.
#
#   scripts/dev-k3s.sh up        start k3s, preload images, apply guard rails
#   scripts/dev-k3s.sh images    rebuild + load the harness image
#   scripts/dev-k3s.sh apply     re-render and apply manifests from config
#   scripts/dev-k3s.sh down      delete the cluster container (agent data is lost)
#   scripts/dev-k3s.sh kubectl … run kubectl as cluster admin (debugging only)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.agentown"
NAME="${AGENTOWN_K3S_NAME:-agentown-k3s}"
K3S_IMAGE="${AGENTOWN_K3S_IMAGE:-rancher/k3s:v1.30.6-k3s1}"
HARNESS_IMAGE="agentown/harness:0.1.0"
SYSTEM_IMAGES=(
  rancher/mirrored-pause:3.6
  rancher/mirrored-coredns-coredns:1.11.3
  rancher/local-path-provisioner:v0.0.30
  rancher/mirrored-library-busybox:1.36.1
)
mkdir -p "$STATE/k3s-images"

kc() { docker exec -i "$NAME" kubectl "$@"; }

load_image() {
  # Import straight into k3s' containerd so pods never need registry access.
  docker save "$1" | docker exec -i "$NAME" ctr -n k8s.io images import - >/dev/null
  echo "loaded $1"
}

build_harness() {
  (cd "$ROOT" && pnpm --filter @agentown/harness build >/dev/null)
  docker build -q -t "$HARNESS_IMAGE" "$ROOT/apps/harness" >/dev/null
  echo "built $HARNESS_IMAGE"
}

docker_bridge_ip() {
  docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}'
}

apply() {
  local cidr="${AGENTOWN_API_CIDR:-$(docker_bridge_ip)/32}"
  (cd "$ROOT" && AGENTOWN_API_CIDR="$cidr" npx tsx apps/server/src/tools/render-manifests.ts) > "$STATE/manifests.yaml"
  kc apply -f - < "$STATE/manifests.yaml"
}

controller_kubeconfig() {
  # The server runs as the agentown-controller ServiceAccount: namespaced Roles
  # only, no cluster-admin. This is what AGENTOWN_KUBECONFIG should point to.
  local token ca
  token="$(kc -n agentown-system create token agentown-controller --duration=720h)"
  ca="$(kc config view --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"
  umask 077
  cat > "$STATE/controller.kubeconfig" <<EOF
apiVersion: v1
kind: Config
clusters:
- name: agentown
  cluster:
    server: https://127.0.0.1:6443
    certificate-authority-data: $ca
users:
- name: agentown-controller
  user:
    token: $token
contexts:
- name: agentown
  context: { cluster: agentown, user: agentown-controller }
current-context: agentown
EOF
  echo "wrote $STATE/controller.kubeconfig"
}

up() {
  for img in "${SYSTEM_IMAGES[@]}"; do
    docker image inspect "$img" >/dev/null 2>&1 || docker pull -q "$img"
  done
  docker image inspect "$K3S_IMAGE" >/dev/null 2>&1 || docker pull -q "$K3S_IMAGE"
  docker save "${SYSTEM_IMAGES[@]}" -o "$STATE/k3s-images/system.tar"

  if ! docker inspect "$NAME" >/dev/null 2>&1; then
    docker run -d --name "$NAME" --privileged --restart unless-stopped \
      -p 127.0.0.1:6443:6443 \
      -v "$STATE/k3s-images:/var/lib/rancher/k3s/agent/images" \
      "$K3S_IMAGE" server --disable traefik --disable metrics-server \
      --tls-san 127.0.0.1 >/dev/null
  fi
  echo -n "waiting for k3s"
  until kc get nodes 2>/dev/null | grep -q " Ready"; do echo -n .; sleep 2; done
  echo " ready"
  build_harness
  load_image "$HARNESS_IMAGE"
  apply
  controller_kubeconfig
  echo "API URL for runtimes: http://$(docker_bridge_ip):8080"
}

case "${1:-up}" in
  up) up ;;
  images) build_harness; load_image "$HARNESS_IMAGE" ;;
  apply) apply ;;
  kubeconfig) controller_kubeconfig ;;
  down) docker rm -f "$NAME" ;;
  kubectl) shift; kc "$@" ;;
  *) echo "usage: $0 up|images|apply|kubeconfig|down|kubectl ..." >&2; exit 2 ;;
esac
