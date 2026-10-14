# agentownctl

Set up and operate an Agentown cluster **from your own machine**, on VMs you already have. `agentownctl` reads a cluster file, connects to each VM over SSH, installs the Agentown server on one, joins the others to its k3s cluster as agent nodes, and opens a tunnel to the web UI. It never creates VMs and never opens ports.

A single static binary for macOS, Linux and Windows. It uses your system `ssh`, so your keys, ssh-agent and `~/.ssh/config` apply.

## Install

macOS and Linux:

```bash
curl -fsSL https://agentown.site/cli.sh | sh
```

This downloads the binary for your OS and CPU from the latest [release](https://github.com/wanatabe-yuu/Agentown/releases), checks it against the release's `SHA256SUMS` (and its Sigstore signature, if `cosign` is installed), and puts it in `/usr/local/bin` or `~/.local/bin`. `AGENTOWN_VERSION=v0.1.0` pins a release, `AGENTOWN_INSTALL_DIR` picks the directory.

Windows: download `agentownctl_windows_amd64.exe` from the release page. It needs the OpenSSH client that ships with Windows 10 and later.

## Prepare the VMs

- Ubuntu 24.04, x86_64, systemd.
- You can SSH in with a key, and the SSH user has passwordless `sudo` (the default on GCP, AWS and most clouds).
- Between the VMs, allow TCP 6443 (k3s API), 8080 (agents → Agentown API), 10250 (kubelet) and UDP 8472 (pod network). On GCP: give the VMs a common network tag and one internal firewall rule for these ports.
- Do **not** open 8080 to the Internet. The UI is reached through the tunnel.

## Use

```bash
agentownctl init          # writes agentown.cluster.yaml; fill in your VMs
agentownctl up            # install the server, join the nodes
agentownctl ui            # tunnel: open http://localhost:8080
agentownctl token         # owner token to sign in with
```

An example cluster file:

```yaml
name: agentown
version: latest            # or a release tag such as v0.1.0
driver: kubernetes         # kubernetes (k3s) or docker (single VM, no extra nodes)

ssh:                       # defaults for every host
  user: ubuntu
  identityFile: ~/.ssh/id_ed25519

server:                    # Agentown server, PostgreSQL, k3s control plane
  host: 34.87.10.20
  # internalAddress: 10.148.0.2   # private IP the nodes use (default: detected)

nodes:                     # extra machines for agents
  - host: 34.87.10.21
    pool: shared           # many agents per node
  - host: 34.87.10.22
    name: gpu-box
    pool: dedicated        # one agent per node, for presets with placement: dedicated-node

org: ./agentown.yaml       # optional: your org config (departments, templates, permissions)
```

Any host can override `user`, `port` and `identityFile`. Paths are relative to the cluster file.

## Commands

| Command | What it does |
|---|---|
| `init` | Write an example `agentown.cluster.yaml`. |
| `up [--force]` | Check every VM (SSH, sudo, OS, CPU), upload the org config if it changed, install or upgrade the server when its version differs, join missing nodes with the server's k3s version, keep each node's pool label and taint in line with the file, and copy the agent image to nodes that lack it. Safe to run again; it only changes what differs. `--force` re-runs the installer anyway. |
| `status` | Server version and health, nodes with their pools, agent pods. |
| `ui [--port 8080]` | SSH tunnel from `localhost:PORT` to the server's UI. Ctrl-C closes it. |
| `token` | Print the owner token. |
| `logs [-n 100] [-f]` | Server log; `-f` follows it. |
| `ssh [NODE]` | Shell on the server, or on a node by name. |
| `version` | The CLI's version. |

The cluster file comes from `-c FILE`, then `$AGENTOWN_CLUSTER`, then `./agentown.cluster.yaml`. Put `-c` right after the command: `agentownctl status -c prod.yaml`.

To upgrade, set `version` (or keep `latest`) and run `agentownctl up`. Nodes removed from the file are not removed from the cluster; `up` lists them so you can drain them yourself.

## What happens on the server

`up` runs the same signed installer as the one-line install: it verifies the release's Sigstore signature and checksums, installs Node 22, PostgreSQL and k3s, and runs the `agentown` systemd service. On the server itself the host tool is also called `agentownctl` (`status`, `logs`, `token`, `upgrade`, `rollback`, `kubectl`); see the [docs](https://agentown.site/docs/).

## Develop

```bash
cd cli
go test ./...
go build -o agentownctl .
../scripts/build-cli.sh v0.0.0-dev ../dist-cli   # all platforms
```

Go 1.24, one dependency (`gopkg.in/yaml.v3`). Remote work is plain bash sent to `sudo -n bash -s` over SSH; every value from the cluster file is validated and shell-quoted.
