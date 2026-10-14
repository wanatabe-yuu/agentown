#!/usr/bin/env bash
# Install or upgrade Agentown on a fresh Ubuntu 24.04 (x86_64) host, from a
# signed GitHub release. One command, as root:
#
#   curl -fsSL https://github.com/wanatabe-yuu/Agentown/releases/latest/download/install.sh | sudo bash
#
# Re-running it upgrades to the latest release and keeps config, data and keys.
#
# Options (environment variables):
#   AGENTOWN_VERSION=v0.1.0       install this release instead of the latest
#   AGENTOWN_DRIVER=kubernetes    runtime driver: kubernetes (k3s on this host, default) or docker
#   AGENTOWN_REPO=owner/name      GitHub repository to install from (default wanatabe-yuu/Agentown)
#
# What it does: installs Node 22, PostgreSQL, k3s (or Docker), verifies the
# release's Sigstore signature and checksums, unpacks it to /opt/agentown,
# loads the agent runtime image, applies the cluster guard rails, and runs the
# server as the `agentown` systemd service on port 8080. Port 8080 must stay
# closed to the Internet: open the UI through an SSH tunnel.
set -euo pipefail
umask 022

REPO="${AGENTOWN_REPO:-wanatabe-yuu/Agentown}"
DRIVER="${AGENTOWN_DRIVER:-kubernetes}"
K3S_VERSION="v1.30.6+k3s1"
COSIGN_VERSION="v3.0.6"
COSIGN_SHA256="c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74" # cosign-linux-amd64
# Only releases built by this repository's release workflow, from a v* tag or
# from main (manual "Run workflow"), are accepted.
SIGNER_IDENTITY="^https://github\\.com/(?i:${REPO//./\\.})/\\.github/workflows/release\\.yml@refs/(tags/v|heads/main$)"
SIGNER_ISSUER="https://token.actions.githubusercontent.com"

PREFIX=/opt/agentown
ETC=/etc/agentown
STATE=/var/lib/agentown
LIB=/usr/local/lib/agentown

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root: curl -fsSL https://github.com/wanatabe-yuu/Agentown/releases/latest/download/install.sh | sudo bash"
[ "$(uname -m)" = x86_64 ] || die "only x86_64 hosts are supported (the agent image is built for linux/amd64)"
command -v apt-get >/dev/null && command -v systemctl >/dev/null || die "needs a Debian/Ubuntu host with systemd"
case "$DRIVER" in kubernetes|docker) ;; *) die "AGENTOWN_DRIVER must be kubernetes or docker" ;; esac

# ---------------------------------------------------------------------------
say "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git jq openssl postgresql iproute2 >/dev/null

if ! command -v node >/dev/null || ! node -v | grep -q '^v22\.'; then
  say "Installing Node.js 22 (NodeSource apt repository)"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q && apt-get install -y -q nodejs >/dev/null
fi

if [ "$DRIVER" = docker ] && ! command -v docker >/dev/null; then
  say "Installing Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -q && apt-get install -y -q docker-ce docker-ce-cli containerd.io >/dev/null
fi

if [ "$DRIVER" = kubernetes ] && ! command -v k3s >/dev/null; then
  say "Installing k3s $K3S_VERSION"
  curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" sh -s - server \
    --disable traefik --write-kubeconfig-mode 600 --node-label agentown.io/pool=shared
fi

# ---------------------------------------------------------------------------
say "Fetching release"
install -d -m 0755 "$LIB"
if ! echo "$COSIGN_SHA256  $LIB/cosign" | sha256sum -c --status 2>/dev/null; then
  curl -fsSL -o "$LIB/cosign.tmp" "https://github.com/sigstore/cosign/releases/download/$COSIGN_VERSION/cosign-linux-amd64"
  echo "$COSIGN_SHA256  $LIB/cosign.tmp" | sha256sum -c --status || die "cosign download does not match its pinned checksum"
  chmod 0755 "$LIB/cosign.tmp" && mv "$LIB/cosign.tmp" "$LIB/cosign"
fi

TAG="${AGENTOWN_VERSION:-}"
if [ -z "$TAG" ]; then
  TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | jq -r .tag_name)"
  [ -n "$TAG" ] && [ "$TAG" != null ] || die "no published release found in $REPO"
fi
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || die "unexpected release tag '$TAG'"

DL="$(mktemp -d)"
trap 'rm -rf "$DL"' EXIT
BUNDLE="agentown-$TAG.tar.gz"
IMAGE="agentown-harness-$TAG-amd64.tar.gz"
for f in SHA256SUMS SHA256SUMS.sigstore.json "$BUNDLE" "$IMAGE"; do
  curl -fsSL --retry 3 -o "$DL/$f" "https://github.com/$REPO/releases/download/$TAG/$f" || die "could not download $f from release $TAG"
done

say "Verifying signature and checksums"
"$LIB/cosign" verify-blob --bundle "$DL/SHA256SUMS.sigstore.json" \
  --certificate-identity-regexp "$SIGNER_IDENTITY" --certificate-oidc-issuer "$SIGNER_ISSUER" \
  "$DL/SHA256SUMS" >/dev/null 2>&1 \
  || die "SHA256SUMS is not signed by $REPO's release workflow; refusing to install"
for f in "$BUNDLE" "$IMAGE"; do
  line="$(awk -v f="$f" '$2 == f || $2 == "*" f' "$DL/SHA256SUMS")"
  [ -n "$line" ] || die "$f is not listed in SHA256SUMS"
  (cd "$DL" && echo "$line" | sha256sum -c --status) || die "checksum mismatch for $f"
done
echo "signed by $REPO release workflow, checksums OK"

# ---------------------------------------------------------------------------
say "Installing $TAG to $PREFIX"
id agentown >/dev/null 2>&1 || useradd --system --home-dir "$STATE" --shell /usr/sbin/nologin agentown
install -d -m 0755 "$PREFIX/releases"
install -d -m 0750 -o root -g agentown "$ETC"
install -d -m 0700 -o agentown -g agentown "$STATE"
rm -rf "$PREFIX/releases/$TAG.new"
mkdir "$PREFIX/releases/$TAG.new"
tar -xzf "$DL/$BUNDLE" -C "$PREFIX/releases/$TAG.new" --strip-components=1 --no-same-owner
rm -rf "$PREFIX/releases/$TAG"
mv "$PREFIX/releases/$TAG.new" "$PREFIX/releases/$TAG"
ln -sfn "releases/$TAG" "$PREFIX/current.new" && mv -T "$PREFIX/current.new" "$PREFIX/current"
ln -sfn "$PREFIX/current/bin/agentownctl" /usr/local/bin/agentownctl
# Keep the current release and the two most recent others (for rollback).
ls -1dt "$PREFIX"/releases/v* 2>/dev/null | { grep -vxF "$PREFIX/releases/$TAG" || true; } | tail -n +3 | xargs -r rm -rf

HARNESS_IMAGE="$(sed -n 's/^harness_image=//p' "$PREFIX/current/VERSION")"
if [ ! -f "$ETC/agentown.yaml" ]; then
  install -m 0640 -o root -g agentown "$PREFIX/current/config/agentown.yaml" "$ETC/agentown.yaml"
elif ! grep -q "image: $HARNESS_IMAGE\$" "$ETC/agentown.yaml"; then
  install -m 0640 -o root -g agentown "$PREFIX/current/config/agentown.yaml" "$ETC/agentown.yaml.new"
  echo "note: $ETC/agentown.yaml does not use $HARNESS_IMAGE; compare it with $ETC/agentown.yaml.new"
fi

# ---------------------------------------------------------------------------
say "Preparing PostgreSQL"
systemctl enable --now postgresql >/dev/null
if [ ! -s "$ETC/db-password" ]; then
  (umask 077 && openssl rand -hex 24 > "$ETC/db-password")
fi
DB_PASSWORD="$(cat "$ETC/db-password")"
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='agentown'" | grep -q 1; then
  sudo -u postgres psql -q <<<"ALTER ROLE agentown WITH LOGIN PASSWORD '$DB_PASSWORD'"
else
  sudo -u postgres psql -q <<<"CREATE ROLE agentown LOGIN PASSWORD '$DB_PASSWORD'"
fi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='agentown'" | grep -q 1 \
  || sudo -u postgres createdb -O agentown agentown

# ---------------------------------------------------------------------------
HOST_IP="$(ip -4 route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}')"
[ -n "$HOST_IP" ] || die "could not determine this host's primary IPv4 address"
# The server listens on this address (agent runtimes reach it there). On a
# public address, only a firewall keeps port 8080 off the Internet.
case "$HOST_IP" in
  10.* | 192.168.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].* | 100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].*) PUBLIC_IP="" ;;
  *) PUBLIC_IP=1 ;;
esac

if [ "$DRIVER" = kubernetes ]; then
  say "Loading agent image and applying cluster guard rails"
  kc() { k3s kubectl "$@"; }
  for _ in $(seq 60); do kc get nodes 2>/dev/null | grep -q " Ready" && break; sleep 2; done
  kc get nodes 2>/dev/null | grep -q " Ready" || die "k3s is not ready (journalctl -u k3s)"
  gunzip -c "$DL/$IMAGE" | k3s ctr -n k8s.io images import - >/dev/null
  AGENTOWN_CONFIG="$ETC/agentown.yaml" AGENTOWN_API_CIDR="$HOST_IP/32" \
    node "$PREFIX/current/server/tools/render-manifests.mjs" > "$STATE/manifests.yaml"
  kc apply -f "$STATE/manifests.yaml" >/dev/null
  # A long-lived token for the controller ServiceAccount (namespaced Roles only, no cluster-admin).
  kc apply -f - >/dev/null <<'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: agentown-controller-token
  namespace: agentown-system
  annotations: { kubernetes.io/service-account.name: agentown-controller }
type: kubernetes.io/service-account-token
EOF
  token=""
  for _ in $(seq 30); do
    token="$(kc -n agentown-system get secret agentown-controller-token -o jsonpath='{.data.token}' 2>/dev/null | base64 -d || true)"
    [ -n "$token" ] && break; sleep 1
  done
  [ -n "$token" ] || die "the controller ServiceAccount token was not issued"
  ca="$(kc config view --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"
  (umask 077 && cat > "$STATE/controller.kubeconfig" <<EOF
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
  )
  chown agentown:agentown "$STATE/controller.kubeconfig" "$STATE/manifests.yaml"
  RUNTIME_API_URL="http://$HOST_IP:8080"
else
  say "Loading agent image into Docker"
  systemctl enable --now docker >/dev/null
  docker load -i "$DL/$IMAGE" >/dev/null
  # The docker driver talks to the Docker socket, which is root-equivalent.
  usermod -aG docker agentown
  RUNTIME_API_URL="http://host.docker.internal:8080"
fi

# ---------------------------------------------------------------------------
say "Configuring the agentown service"
# Rewritten on every install; put your own overrides in $ETC/local.env.
cat > "$ETC/agentown.env" <<EOF
NODE_ENV=production
DATABASE_URL=postgres://agentown:$DB_PASSWORD@127.0.0.1:5432/agentown
AGENTOWN_STATE_DIR=$STATE
AGENTOWN_CONFIG=$ETC/agentown.yaml
AGENTOWN_WEB_DIST=$PREFIX/current/web
AGENTOWN_RUNTIME_DRIVER=$DRIVER
AGENTOWN_KUBECONFIG=$STATE/controller.kubeconfig
AGENTOWN_RUNTIME_API_URL=$RUNTIME_API_URL
HOST=0.0.0.0
PORT=8080
EOF
chown root:agentown "$ETC/agentown.env" "$ETC/db-password" && chmod 0640 "$ETC/agentown.env" "$ETC/db-password"

if [ "$DRIVER" = kubernetes ]; then AFTER="k3s.service"; else AFTER="docker.service"; fi
cat > /etc/systemd/system/agentown.service <<EOF
[Unit]
Description=Agentown server
After=network-online.target postgresql.service $AFTER
Wants=network-online.target

[Service]
User=agentown
Group=agentown
EnvironmentFile=$ETC/agentown.env
EnvironmentFile=-$ETC/local.env
WorkingDirectory=$STATE
ExecStart=/usr/bin/node $PREFIX/current/server/main.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=$STATE

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable agentown >/dev/null
systemctl restart agentown

for _ in $(seq 30); do curl -fsS --noproxy "*" http://127.0.0.1:8080/healthz >/dev/null 2>&1 && break; sleep 1; done
curl -fsS --noproxy "*" http://127.0.0.1:8080/healthz >/dev/null 2>&1 || die "server did not come up: journalctl -u agentown -n 50"

cat <<EOF

Agentown $TAG is running (driver: $DRIVER).

  Owner token:   sudo agentownctl token
  Status / logs: agentownctl status | sudo agentownctl logs
  Upgrade:       curl -fsSL https://github.com/wanatabe-yuu/Agentown/releases/latest/download/install.sh | sudo bash

Open the UI from your own machine through an SSH tunnel (keep port 8080 closed):
  ssh -L 8080:localhost:8080 ${SUDO_USER:-$(logname 2>/dev/null || echo you)}@<this host>
  then browse to http://localhost:8080 and paste the owner token.

Back up $STATE/secret-key: it encrypts the stored API keys.
EOF
if [ -n "$PUBLIC_IP" ]; then
  printf '\n\033[31mWARNING:\033[0m the primary address %s of this host is public. Block TCP 8080 from\nthe Internet (cloud firewall, security group or ufw): the UI has no TLS and only the owner token protects it.\n' "$HOST_IP"
fi
