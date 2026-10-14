# Running Agentown on GCP

## How many resources are needed

No part of Agentown is compute-heavy: the server, Postgres, and controller mostly wait on I/O. The LLM runs on the provider's side. Resource usage grows with the **number of running agents**, because each agent is a Pod with its own CPU/RAM limits (declared in `runtimeCatalog`).

| Component | CPU | RAM | Notes |
|---|---|---|---|
| k3s control plane + system | ~0.5 | ~1 GB | |
| Postgres + server + UI | ~0.5 | ~1 GB | |
| Each `script-v1` agent | 0.25 | 256 MiB | hard limit in the Pod |
| Each `claude-v1` agent | 0.5 | 512 MiB | the model's commands run on the agent's machine |
| Each `claude-dedicated-v1` agent | 1 | 2 GiB | **occupies an entire node of its own** |

Suggestions:

| Purpose | Machine | Estimated capacity |
|---|---|---|
| Testing | 1 × `e2-standard-2` (2 vCPU, 8 GB), 30 GB disk | ~5 script agents or ~3 LLM agents |
| **Recommended for a trial** | 1 × `e2-standard-4` (4 vCPU, 16 GB), 50 GB `pd-balanced` disk, Ubuntu 24.04 | ~10 script agents or ~6 LLM agents, plus the demo |
| Each “own node” employee | add 1 × `e2-standard-2` per dedicated agent | 1 agent / node |

Reference on‑demand pricing (us-central1, excluding disk and network): `e2-standard-2` about 50 USD/month, `e2-standard-4` about 100 USD/month. The Singapore region is slightly more expensive. When the VM is stopped while not in use, you only pay for the disk.

## Create the VM

```bash
ZONE=asia-southeast1-b
gcloud compute instances create agentown-1 \
  --zone=$ZONE --machine-type=e2-standard-4 \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=50GB --boot-disk-type=pd-balanced --tags=agentown

# Only Agentown VMs talk to each other (k3s API, flannel VXLAN, kubelet, agents -> Agentown API).
gcloud compute firewall-rules create agentown-internal --network=default \
  --allow=tcp:6443,udp:8472,tcp:10250,tcp:8080 --source-tags=agentown --target-tags=agentown
```

**Do not open port 8080 to the Internet** (this version has no TLS or user login yet). Open the UI through an SSH tunnel:

```bash
gcloud compute ssh agentown-1 --zone=$ZONE -- -L 8080:localhost:8080
# then open http://localhost:8080 on your machine
```

## Set up from your machine with agentownctl

The quickest path for one or more VMs. On your laptop:

```bash
curl -fsSL https://agentown.site/cli.sh | sh
agentownctl init
```

Create the VMs and the `agentown-internal` firewall rule as above (every VM with the `agentown` tag). Edit `agentown.cluster.yaml`: the server's external IP, your SSH user (on GCP, the user your key is registered for), and one entry per extra node. Then:

```bash
agentownctl up
agentownctl ui        # http://localhost:8080
agentownctl token
```

See [`cli/README.md`](../cli/README.md). The next section is the same server install, done by hand on the VM.

## Install on the VM

SSH into the VM and run a single command:

```bash
curl -fsSL https://github.com/wanatabe-yuu/Agentown/releases/latest/download/install.sh | sudo bash
```

The script downloads the latest release built by GitHub Actions, verifies the Sigstore signature and checksum (see [RELEASING.md](RELEASING.md)), installs Node 22, PostgreSQL, and k3s, loads the agent image into k3s, applies the guard rails (RBAC, Pod Security, admission policy, NetworkPolicy), and then runs the server as the `agentown` systemd service. The script can be rerun safely; rerunning it performs an upgrade.

| Path | Contents |
|---|---|
| `/opt/agentown/current` | the running release (2 older releases are kept for rollback) |
| `/etc/agentown/agentown.yaml` | organization config. Created only on the first install; after that it is yours |
| `/etc/agentown/agentown.env` | environment variables rewritten by the installer on every install; add your own variables to `/etc/agentown/local.env` |
| `/var/lib/agentown` | owner token, `secret-key`, the controller's kubeconfig |

```bash
sudo agentownctl token      # owner token
agentownctl status          # version, service, health
sudo agentownctl logs       # journalctl -u agentown -f
sudo agentownctl upgrade    # latest release, or: upgrade v0.2.0
sudo agentownctl rollback   # go back to the previous release (does not roll back the DB schema)
```

Optional variables: `AGENTOWN_VERSION=v0.1.0` to install a pinned release, `AGENTOWN_DRIVER=docker` to use Docker instead of k3s (for example `curl -fsSL https://github.com/wanatabe-yuu/Agentown/releases/latest/download/install.sh | sudo AGENTOWN_DRIVER=docker bash`).

**Back up `/var/lib/agentown/secret-key`.** The API keys stored in the DB are encrypted with this key; lose the key and you lose the API keys.

### Install from source (for development)

```bash
git clone https://github.com/wanatabe-yuu/Agentown agentown && cd agentown
sudo bash deploy/gcp/setup-vm.sh          # Docker, Node 22, pnpm, Postgres, k3s
pnpm install && pnpm build:web
sudo AGENTOWN_K3S_MODE=native scripts/dev-k3s.sh up      # agent image, guard rails, kubeconfig for the controller
sudo scripts/verify-k8s-guardrails.sh                    # RBAC + admission must pass 18/18
AGENTOWN_K3S_MODE=native scripts/dev-server.sh           # server using the kubernetes driver
scripts/demo.sh                                          # CEO → leader → engineer → QA running for real on Pods
```

When running from source in a real environment, set `AGENTOWN_SECRET_KEY` (32 bytes, base64: `openssl rand -base64 32`) instead of the auto-generated dev key file `.agentown/secret-key`. Store this key somewhere safe: lose the key and you lose the stored API keys.

## Adding nodes (one node per employee)

Each agent is **always** its own Pod. If you want an agent to have **its own machine**, hire the agent with a template that uses the `claude-dedicated-v1` preset (for example `engineer-claude-dedicated-v1`) and add one “dedicated” VM for each such agent:

```bash
# On the server VM, print the join command:
sudo scripts/add-node.sh dedicated
# Create a new VM (with the same agentown tag), then run the printed command on that VM.
```

Dedicated nodes are labeled and tainted so that only dedicated Pods run there, and each node accepts only one dedicated agent (pod anti‑affinity). If you hire a dedicated agent when no free node is available, the agent's Pod stays in `pending: Unschedulable` (shown in the UI) until you add a node. Automatically creating a VM for each hire (node autoscaling) is not implemented yet.

With multiple nodes, the agent image must be present on every node: push `agentown/harness` to Artifact Registry and update `image` in `runtimeCatalog`, while keeping the image list in the admission policy in sync (it is generated automatically from the catalog).

## Letting a coding agent work on the VM

A Claude Code session running in the cloud cannot SSH out, because its environment only allows outbound HTTPS through a proxy. Run Claude Code directly on the VM instead:

```bash
sudo apt-get install -y nodejs   # already installed if you ran install.sh
sudo npm install -g @anthropic-ai/claude-code
claude                           # in your working directory
```

That agent can use `agentownctl status`, `sudo agentownctl logs`, and `curl http://127.0.0.1:8080/healthz` to inspect the service.
