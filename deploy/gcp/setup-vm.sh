#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 GCP VM as the Agentown host:
# Docker, Node 22 + pnpm, PostgreSQL 16, k3s (server). Idempotent; run as root:
#
#   sudo bash deploy/gcp/setup-vm.sh
#
# Optional: AGENTOWN_EXTRA_SSH_KEY="ssh-ed25519 AAAA… comment" adds a public key
# for the current sudo user (e.g. to let a remote coding agent in).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
USER_NAME="${SUDO_USER:-$(logname 2>/dev/null || echo root)}"

apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git jq postgresql postgresql-contrib

# Docker (agent image builds; also the docker runtime driver)
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -q && apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin
  usermod -aG docker "$USER_NAME" || true
fi

# Node 22 + pnpm
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
corepack enable && corepack prepare pnpm@10 --activate

# PostgreSQL: role + databases
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='agentown'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE agentown LOGIN PASSWORD 'agentown' CREATEDB"
for db in agentown agentown_test; do
  sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 \
    || sudo -u postgres createdb -O agentown "$db"
done

# k3s server (containerd runtime; the dedicated/shared pools are separate VMs, see scripts/add-node.sh)
if ! command -v k3s >/dev/null; then
  curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=v1.30.6+k3s1 sh -s - server \
    --disable traefik --write-kubeconfig-mode 600 --node-label agentown.io/pool=shared
fi

if [ -n "${AGENTOWN_EXTRA_SSH_KEY:-}" ]; then
  home="$(getent passwd "$USER_NAME" | cut -d: -f6)"
  install -d -m 700 -o "$USER_NAME" "$home/.ssh"
  grep -qF "$AGENTOWN_EXTRA_SSH_KEY" "$home/.ssh/authorized_keys" 2>/dev/null || echo "$AGENTOWN_EXTRA_SSH_KEY" >> "$home/.ssh/authorized_keys"
  chown "$USER_NAME" "$home/.ssh/authorized_keys" && chmod 600 "$home/.ssh/authorized_keys"
fi

echo
echo "Host ready. Next (in the repo checkout):"
echo "  pnpm install && pnpm build:web"
echo "  sudo AGENTOWN_K3S_MODE=native scripts/dev-k3s.sh up"
echo "  AGENTOWN_K3S_MODE=native scripts/dev-server.sh"
