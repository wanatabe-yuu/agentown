#!/usr/bin/env bash
# Print the command that joins another machine (e.g. a new GCP VM) to the k3s
# cluster as an agent node. Run on the k3s server host as root.
#
#   scripts/add-node.sh shared      node for ordinary agents (many per node)
#   scripts/add-node.sh dedicated   node reserved for ONE agent on a dedicated-node preset
#
# Dedicated nodes are labelled agentown.io/pool=dedicated and tainted so only
# dedicated agent pods (which tolerate the taint) land there; pod anti-affinity
# keeps it to one dedicated agent per node. With no free dedicated node a newly
# hired dedicated agent stays Pending ("Unschedulable") until you add one.
set -euo pipefail
KIND="${1:-shared}"
SERVER_IP="${AGENTOWN_K3S_SERVER_IP:-$(ip -4 route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}')}"
TOKEN="$(cat /var/lib/rancher/k3s/server/node-token)"
ARGS="agent"
case "$KIND" in
  shared) ARGS="$ARGS --node-label agentown.io/pool=shared" ;;
  dedicated) ARGS="$ARGS --node-label agentown.io/pool=dedicated --node-taint agentown.io/dedicated=true:NoSchedule" ;;
  *) echo "usage: $0 shared|dedicated" >&2; exit 2 ;;
esac
cat <<CMD
# Run on the new machine (same VPC; TCP 6443 and UDP 8472 to $SERVER_IP must be open):
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=v1.30.6+k3s1 K3S_URL=https://$SERVER_IP:6443 K3S_TOKEN=$TOKEN sh -s - $ARGS
# Then load the agent image on it (or push agentown/harness to a registry the nodes can pull from):
#   docker save agentown/harness:<version> | ssh <new-node> sudo k3s ctr -n k8s.io images import -
CMD
