# Decisions & assumptions at the start of the build

Date: 2026-10-14. Context: [AGENTOWN_HANDOFF.md](./AGENTOWN_HANDOFF.md). The user's instruction: “pick a direction and build it”.
The items below are the choices made for the first build; the **Reversible?** column indicates the cost of changing them later.

## Chosen

| # | Issue (handoff §13) | Choice | Reason | Reversible? |
|---|---|---|---|---|
| 1 | Fork or build from scratch | **Build from scratch**, TypeScript monorepo (`packages/core`, `apps/server`, `apps/harness`, `apps/web`) | The core value is a permission model decoupled from job titles; the reference projects do not have this grant/scope model built in. One language for the server, harness, and UI. | Medium |
| 2 | k3s or Swarm | **k3s is the target**, plus a **Docker driver** for single-machine/dev | k3s provides ServiceAccount, RBAC, Pod Security, ValidatingAdmissionPolicy, NetworkPolicy — a second wall independent of the backend. The Docker driver exists because this build sandbox cannot run Pods (see “Environment limitations”) and because it is useful for dev. Both share the `RuntimeDriver` interface. | Easy (drivers are plugins) |
| 3 | Container or VM | **Container** (non-root, read-only rootfs, drop ALL caps, seccomp RuntimeDefault, no k8s token) | Sufficient for functional testing. If “own OS” means its own kernel → switch `runtimeClassName` to gVisor/Kata in the k8s driver; nothing else is affected. | Easy |
| 4 | Model/provider/harness | **Adapter 1: `script`** (playbook/shell, no LLM) for runtime acceptance testing; **adapter 2: `claude`** (Anthropic SDK, `bash` tool, default model `claude-opus-5-5`, server-side refusal fallback enabled) | The handoff did not include a model account. The script adapter makes it possible to prove the task-assignment/permission/recovery loop with real side effects, not animation. | Easy |
| 5 | Does a leader manage direct reports or descendants | **Declared per grant** in config; fixture: exec/control = `direct-reports`, task = `team` | Handoff §5.3 rule 5: scope must be explicit, not inferred from job title. | Easy (edit config) |
| 6 | How far can the CEO grant permissions | Only **grants with the `delegable` flag**, and only when it can be **proven** that the new scope lies within the parent scope; a delegated grant dies with its parent grant | Rules 3–4: spawn ≠ delegate. Fixture: the CEO does **not have** `runtime.exec`. | Easy |
| 7 | Pause | Split into 3 operations: **pause/resume intake**, **stop/start runtime**, **cancel task** | Handoff §13. Stopping the runtime increments the generation → in-flight runs are marked lost and requeued. | — |
| 8 | Who does the PO report to | The CEO; permissions by **project** (`website`), no runtime.*/spawn | Handoff §13. | Easy |
| 9 | 2D style | Top‑down, drawn with Canvas 2D (no PixiJS) | Few dependencies; sufficient for the MVP. | Easy |
| 10 | Exec/SSH | **Kubernetes exec / Docker exec via the backend**, single-use tickets bound to actor + agent + generation; the server closes the session when permissions change | Satisfies “SSH or exec” without needing SSH infrastructure. | — |

## Additions after user feedback (2026-10-14)

| Issue | Choice | Reason |
|---|---|---|
| One API key for everything? | **No.** A key store managed by the owner; each agent picks a key + a model that key has access to; a leader/CEO can change this via `agent.configure` | The user wants per-agent configuration and model selection per key. Spending against a key is a permission, so it must have its own action and be audited. |
| Where to store keys | Postgres, encrypted with AES-256-GCM using `AGENTOWN_SECRET_KEY`; injected into each agent's own Secret | No extra secrets system needed right now. Can move to KMS/Vault later without changing the API. |
| “Each employee gets its own Pod or node” | Always one Pod per agent; a `placement: dedicated-node` preset for agents that need their own machine (nodeSelector + taint/toleration + anti-affinity); add nodes with `scripts/add-node.sh` | Keeps k3s as the orchestrator (like Swarm, but with RBAC/admission). Automatically creating a VM on hire is deferred. |
| Is Rust needed | **Not yet.** The system mostly waits on I/O (DB, Kubernetes API, remote LLM). Heavy work runs inside the agent's runtime, in whatever language that work itself uses. | If there are thousands of agents later, the event gateway or terminal proxy can be split out and written in Go/Rust; the HTTP contract stays the same. |

## Key design conventions

- **Identity ≠ runtime.** `agentId` is durable; the Pod/container is `agent-<id>-g<generation>`. Every call from the harness carries `generation`; a stale generation is rejected (`409 stale_runtime`).
- **Scope is relative and recomputed on every request** against the current reporting graph → changing a reporting relationship changes permissions immediately (verified: an open terminal gets closed).
- **Template = an owner-approved permission bundle** (in `config/agentown.yaml`). `agent.spawn` lists exactly which templates; agents do not submit any manifest/image/mount.
- **Inline script = exec.** A `script`-type task runs with the recipient's identity and data, so the server requires `runtime.exec` on the recipient. A playbook (a script already in the image, parameterized via environment variables) only needs `task.create`.
- **Intentional data sharing:** an agent can read another agent's task/artifact only when its own task references it (`inputTaskIds`) and the creator of that task already had permission to view it.
- **Run lease + idempotency key `taskId:attempt`:** at most one run per attempt; lease expiry/runtime replacement → `lost` → bounded requeue (`max_attempts`). No exactly-once claim for external side effects; playbooks use idempotency keys when creating tasks/spawning.
- **Audit is separate from work logs**; denials are recorded outside the transaction (not rolled back); tokens/secrets are filtered out of logs, events, and audit.

## Build environment limitations (candid)

- The build sandbox allows Docker and can run the **k3s control plane**, but **cannot run Pods**: the kernel forbids the negative `oom_score_adj` that kubelet always sets for the pod sandbox. Working around this limitation was refused and was not done.
- Therefore: the k8s part was verified against a **real API server** (RBAC, Pod Security, admission, and `KubernetesDriver` successfully creating SA/PVC/Secret/Pod), but **an agent Pod has not yet been seen running on k3s**. The real end‑to‑end run loop was verified with the **Docker driver**.
- The `claude` adapter **has not run against the real API** (no key from the user yet). The tool-use loop was tested against a local mock Messages API. The server did call the real provider to validate a key, and an invalid key was correctly rejected.
- Dedicated-node scheduling was checked on real k3s: the first dedicated Pod was scheduled onto the dedicated node, and the second Pod was rejected due to anti‑affinity. The Pod could not start because of the sandbox limitation described above.

## Needed from the user / next decisions

1. A real Linux machine (or VM) to run `AGENTOWN_K3S_MODE=native scripts/dev-k3s.sh up` and confirm Pods run on k3s.
2. An API key (add it in the UI → API keys) if LLM agents are wanted.
3. Isolation level: container (current) or gVisor/Kata/microVM.
4. Visual style of the office (currently a simple hand-drawn top‑down view).
