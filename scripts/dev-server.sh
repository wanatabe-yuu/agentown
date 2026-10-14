#!/usr/bin/env bash
# Run the Agentown server locally.
#   AGENTOWN_RUNTIME_DRIVER=kubernetes (default): k3s via .agentown/controller.kubeconfig (scripts/dev-k3s.sh)
#   AGENTOWN_RUNTIME_DRIVER=docker: one container per agent on the local Docker daemon
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo 172.17.0.1)"
export DATABASE_URL="${DATABASE_URL:-postgres://agentown:agentown@127.0.0.1:5432/agentown}"
export AGENTOWN_RUNTIME_DRIVER="${AGENTOWN_RUNTIME_DRIVER:-kubernetes}"
export AGENTOWN_KUBECONFIG="${AGENTOWN_KUBECONFIG:-$ROOT/.agentown/controller.kubeconfig}"
if [ "$AGENTOWN_RUNTIME_DRIVER" = docker ]; then
  export AGENTOWN_RUNTIME_API_URL="${AGENTOWN_RUNTIME_API_URL:-http://host.docker.internal:8080}"
else
  export AGENTOWN_RUNTIME_API_URL="${AGENTOWN_RUNTIME_API_URL:-http://$BRIDGE:8080}"
fi
exec npx tsx "$ROOT/apps/server/src/main.ts"
