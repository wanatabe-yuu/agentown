package main

import (
	"fmt"
	"strings"
)

// Bash run as root on the VMs. Inputs arrive as quoted variables (withVars).

// factsScript prints key=value facts about a host.
const factsScript = `
. /etc/os-release
echo "os=$ID"
echo "os_version=$VERSION_ID"
echo "arch=$(uname -m)"
echo "hostname=$(hostname)"
echo "systemd=$(command -v systemctl >/dev/null && echo yes || echo no)"
echo "ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' || true)"
echo "installed=$(sed -n 's/^version=//p' /opt/agentown/current/VERSION 2>/dev/null || true)"
echo "k3s=$(k3s --version 2>/dev/null | awk 'NR==1{print $3}' || true)"
echo "k3s_server=$(systemctl is-active k3s 2>/dev/null || true)"
echo "k3s_agent=$(systemctl is-active k3s-agent 2>/dev/null || true)"
echo "org_sha256=$(sha256sum /etc/agentown/agentown.yaml 2>/dev/null | cut -c1-64 || true)"
`

// checkFacts lists the reasons a host cannot be used.
func checkFacts(f map[string]string) []string {
	var p []string
	switch {
	case f["os"] != "ubuntu":
		p = append(p, strings.TrimSpace(fmt.Sprintf("needs Ubuntu 24.04 (found %s %s)", f["os"], f["os_version"])))
	case f["os_version"] != "24.04":
		p = append(p, "needs Ubuntu 24.04 (found "+f["os_version"]+")")
	}
	if f["arch"] != "x86_64" {
		p = append(p, "needs x86_64 (found "+f["arch"]+")")
	}
	if f["systemd"] != "yes" {
		p = append(p, "needs systemd")
	}
	return p
}

// latestTagScript resolves "latest" on the server, which has Internet access (the laptop may not).
func latestTagScript(repo string) string {
	return withVars(map[string]string{"REPO": repo},
		`curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1`)
}

func uploadOrgScript(base64 string) string {
	return withVars(map[string]string{"ORG_B64": base64}, `
install -d -m 0755 /etc/agentown
tmp=/etc/agentown/agentown.yaml.upload
printf '%s' "$ORG_B64" | base64 -d > "$tmp"
if getent group agentown >/dev/null; then chown root:agentown "$tmp"; chmod 0640 "$tmp"; else chmod 0644 "$tmp"; fi
mv "$tmp" /etc/agentown/agentown.yaml
echo "org config written to /etc/agentown/agentown.yaml"
`)
}

// installScript downloads the release installer and runs it; the installer
// verifies the release's signature and checksums before installing anything.
func installScript(url, tag, driver, repo string) string {
	return withVars(map[string]string{"URL": url, "TAG": tag, "DRIVER": driver, "REPO": repo}, `
f="$(mktemp)"
trap 'rm -f "$f"' EXIT
curl -fsSL --retry 3 -o "$f" "$URL"
AGENTOWN_VERSION="$TAG" AGENTOWN_DRIVER="$DRIVER" AGENTOWN_REPO="$REPO" bash "$f"
`)
}

// joinInfoScript prints the k3s join token and the agent image reference on the server.
const joinInfoScript = `
echo "token=$(cat /var/lib/rancher/k3s/server/node-token)"
img="$(sed -n 's/^harness_image=//p' /opt/agentown/current/VERSION)"
echo "image=$(k3s ctr -n k8s.io images ls -q | grep -E "(^|/)${img}$" | head -n 1 || true)"
`

func joinNodeScript(serverAddr, token, k3sVersion, name, pool string) string {
	return withVars(map[string]string{"SERVER": serverAddr, "JOIN_TOKEN": token, "K3S_VER": k3sVersion, "NODE_NAME": name, "POOL": pool}, `
if systemctl is-active -q k3s 2>/dev/null; then
  echo "this machine runs a k3s server; it cannot also be an agent node" >&2; exit 1
fi
if systemctl is-active -q k3s-agent 2>/dev/null; then
  echo "k3s agent already running"; exit 0
fi
if ! timeout 5 bash -c "</dev/tcp/$SERVER/6443" 2>/dev/null; then
  echo "cannot reach $SERVER:6443. Allow TCP 6443, 8080, 10250 and UDP 8472 between the VMs." >&2; exit 1
fi
args=(agent --node-name "$NODE_NAME" --node-label "agentown.io/pool=$POOL")
if [ "$POOL" = dedicated ]; then args+=(--node-taint "agentown.io/dedicated=true:NoSchedule"); fi
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VER" K3S_URL="https://$SERVER:6443" K3S_TOKEN="$JOIN_TOKEN" sh -s - "${args[@]}"
`)
}

// settleNodeScript runs on the server: keeps the node's pool label and taint in
// line with the cluster file, then waits for the node to be Ready.
func settleNodeScript(name, pool string) string {
	return withVars(map[string]string{"NODE_NAME": name, "POOL": pool}, `
kc() { k3s kubectl "$@"; }
for _ in $(seq 90); do kc get node "$NODE_NAME" >/dev/null 2>&1 && break; sleep 2; done
kc get node "$NODE_NAME" >/dev/null || { echo "node $NODE_NAME did not register with the server" >&2; exit 1; }
kc label node "$NODE_NAME" "agentown.io/pool=$POOL" --overwrite >/dev/null
if [ "$POOL" = dedicated ]; then
  kc taint node "$NODE_NAME" agentown.io/dedicated=true:NoSchedule --overwrite >/dev/null
else
  kc taint node "$NODE_NAME" agentown.io/dedicated- >/dev/null 2>&1 || true
fi
for _ in $(seq 90); do
  if [ "$(kc get node "$NODE_NAME" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')" = True ]; then
    echo "node $NODE_NAME ready (pool $POOL)"; exit 0
  fi
  sleep 2
done
echo "node $NODE_NAME registered but is not Ready" >&2; exit 1
`)
}

func hasImageScript(ref string) string {
	return withVars(map[string]string{"REF": ref}, `if k3s ctr -n k8s.io images ls -q | grep -qxF "$REF"; then echo yes; else echo no; fi`)
}

const statusScript = `
agentownctl status || true
if systemctl is-active -q k3s 2>/dev/null; then
  echo
  k3s kubectl get nodes -L agentown.io/pool || true
  echo
  k3s kubectl get pods -A -l agentown.io/agent -o wide || true
fi
`

const nodeNamesScript = `k3s kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'`
