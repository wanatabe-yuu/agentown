#!/usr/bin/env bash
# Remove Agentown from this host. Run as root:
#
#   sudo agentownctl uninstall            Agentown and all of its data
#   sudo agentownctl uninstall --all      ...and what the installer added: k3s, PostgreSQL, Node.js, Docker
#
# Options: --all, --yes (do not ask for confirmation).
#
# "Agentown and its data" is the service, /opt/agentown, /etc/agentown,
# /var/lib/agentown (owner token, secret-key: stored API keys become
# unrecoverable), the agentown database and role, the cluster namespaces,
# admission policy and agent workloads/volumes, the agent image, the agentown
# user and agentownctl. This cannot be undone.
set -euo pipefail

ALL="" YES=""
for a in "$@"; do
  case "$a" in
    --all) ALL=1 ;;
    --yes | -y) YES=1 ;;
    -h | --help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "error: run as root (sudo)" >&2; exit 1; }

PREFIX=/opt/agentown
ETC=/etc/agentown
STATE=/var/lib/agentown
DRIVER="$(sed -n 's/^AGENTOWN_RUNTIME_DRIVER=//p' "$ETC/agentown.env" 2>/dev/null || true)"
DRIVER="${DRIVER:-kubernetes}"

# What the installer added to this host (recorded since 0.3.0). Older installs
# have no record: they were made on fresh hosts, so assume the installer added
# k3s or Docker (depending on the driver), PostgreSQL and Node.js.
if [ -f "$ETC/installed-components" ]; then
  COMPONENTS="$(tr '\n' ' ' < "$ETC/installed-components")"
  RECORDED=1
else
  if [ "$DRIVER" = docker ]; then COMPONENTS="docker postgresql nodejs"; else COMPONENTS="k3s postgresql nodejs"; fi
  RECORDED=""
fi
has() { case " $COMPONENTS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

cat <<EOF
This removes Agentown from $(hostname):
  - the agentown service, $PREFIX, $ETC, $STATE and agentownctl
  - the owner token and secret-key: API keys stored in Agentown cannot be recovered
  - the agentown database and role
  - all agents: their workloads, workspaces and the agent image ($DRIVER driver)
  - the agentown system user
EOF
if [ -n "$ALL" ]; then
  if [ -n "$RECORDED" ]; then src="as recorded at install time"; else src="no install record, so assumed"; fi
  echo "and, with --all, what the installer added to this host ($src):"
  has k3s && echo "  - k3s, with every workload and volume in the cluster"
  has docker && echo "  - Docker, with every container, image and volume on this host"
  has postgresql && echo "  - PostgreSQL, with EVERY database on this host"
  has nodejs && echo "  - Node.js and the NodeSource apt repository"
  [ -n "${COMPONENTS// /}" ] || echo "  - (nothing: the installer did not add any of them)"
fi

if [ -z "$YES" ]; then
  if ! (exec < /dev/tty) 2>/dev/null; then
    echo "error: no terminal to confirm on; re-run with --yes" >&2
    exit 1
  fi
  printf '\nType "remove agentown" to continue: '
  read -r answer < /dev/tty
  [ "$answer" = "remove agentown" ] || { echo "aborted, nothing was changed"; exit 1; }
fi

say "Stopping the agentown service"
systemctl disable --now agentown >/dev/null 2>&1 || true
rm -f /etc/systemd/system/agentown.service
systemctl daemon-reload

if [ "$DRIVER" = kubernetes ] && command -v k3s >/dev/null && systemctl is-active -q k3s; then
  say "Removing agents and guard rails from the cluster"
  kc() { k3s kubectl "$@"; }
  if [ -f "$STATE/manifests.yaml" ]; then
    kc delete -f "$STATE/manifests.yaml" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
  # Whatever the manifest file did not cover (e.g. a namespace removed from the config later).
  kc delete namespace -l agentown.io/managed=true --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kc delete namespace agentown-system --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kc delete validatingadmissionpolicybinding,validatingadmissionpolicy agentown-runtime-guard --ignore-not-found >/dev/null 2>&1 || true
  if [ -z "$ALL" ] || ! has k3s; then
    for ns in $(kc get namespaces -o name 2>/dev/null | sed -n 's#^namespace/\(agentown-.*\)#\1#p'); do
      kc wait --for=delete "namespace/$ns" --timeout=120s >/dev/null 2>&1 || true
    done
    for ref in $(k3s ctr -n k8s.io images ls -q 2>/dev/null | grep -E '(^|/)agentown/harness:' || true); do
      k3s ctr -n k8s.io images rm "$ref" >/dev/null 2>&1 || true
    done
  fi
fi

if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  if [ "$DRIVER" = docker ] || [ -n "$(docker ps -aq --filter label=app.kubernetes.io/managed-by=agentown)$(docker images -q agentown/harness)" ]; then
    say "Removing agent containers, workspaces and images from Docker"
    docker ps -aq --filter label=app.kubernetes.io/managed-by=agentown | xargs -r docker rm -f >/dev/null 2>&1 || true
    docker volume ls -q --filter label=app.kubernetes.io/managed-by=agentown | xargs -r docker volume rm -f >/dev/null 2>&1 || true
    docker network ls -q --filter label=app.kubernetes.io/managed-by=agentown | xargs -r docker network rm >/dev/null 2>&1 || true
    docker images -q agentown/harness | sort -u | xargs -r docker rmi -f >/dev/null 2>&1 || true
  fi
fi

if command -v psql >/dev/null && systemctl is-active -q postgresql; then
  say "Dropping the agentown database and role"
  sudo -u postgres dropdb --if-exists agentown >/dev/null 2>&1 || true
  sudo -u postgres psql -q -c "DROP ROLE IF EXISTS agentown" >/dev/null 2>&1 || true
fi

say "Removing Agentown files and user"
rm -rf "$PREFIX" "$ETC" "$STATE" /usr/local/lib/agentown
rm -f /usr/local/bin/agentownctl
if id agentown >/dev/null 2>&1; then userdel agentown >/dev/null 2>&1 || true; fi

if [ -n "$ALL" ]; then
  export DEBIAN_FRONTEND=noninteractive
  if has k3s; then
    if [ -x /usr/local/bin/k3s-uninstall.sh ]; then
      say "Uninstalling k3s"
      /usr/local/bin/k3s-uninstall.sh >/dev/null 2>&1 || true
    elif [ -x /usr/local/bin/k3s-agent-uninstall.sh ]; then
      say "Uninstalling the k3s agent"
      /usr/local/bin/k3s-agent-uninstall.sh >/dev/null 2>&1 || true
    fi
  fi
  if has docker && dpkg -s docker-ce >/dev/null 2>&1; then
    say "Uninstalling Docker"
    systemctl disable --now docker docker.socket containerd >/dev/null 2>&1 || true
    apt-get purge -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null 2>&1 || true
    rm -rf /var/lib/docker /var/lib/containerd /etc/apt/sources.list.d/docker.list /etc/apt/keyrings/docker.asc
  fi
  if has postgresql && dpkg -s postgresql >/dev/null 2>&1; then
    say "Uninstalling PostgreSQL"
    systemctl stop postgresql >/dev/null 2>&1 || true
    apt-get purge -y -q 'postgresql*' >/dev/null 2>&1 || true
    rm -rf /var/lib/postgresql /etc/postgresql /etc/postgresql-common /var/log/postgresql
  fi
  if has nodejs && dpkg -s nodejs >/dev/null 2>&1; then
    say "Uninstalling Node.js"
    apt-get purge -y -q nodejs >/dev/null 2>&1 || true
    rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/keyrings/nodesource.gpg
  fi
  apt-get autoremove -y -q >/dev/null 2>&1 || true
fi

echo
echo "Agentown has been removed from $(hostname)."
