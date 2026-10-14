import type { Service, AgentRow, RuntimeRow } from "../service.ts";
import type { PodInfo, RuntimeDriver, RuntimeSpec } from "./driver.ts";

const FATAL_WAITING = new Set([
  "ErrImagePull",
  "ImagePullBackOff",
  "ErrImageNeverPull",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
]);

export interface ControllerOptions {
  apiUrlForRuntimes: string;
  intervalMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Reconciles desired agent state (DB) with real workloads (driver). The DB row
 * only says "running" once the driver reports a Ready pod of the current
 * generation; nothing an agent says can make that true.
 */
export class RuntimeController {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private kick = false;

  constructor(
    private readonly service: Service,
    private readonly driver: RuntimeDriver,
    private readonly opts: ControllerOptions,
  ) {}

  start(): void {
    const loop = async () => {
      await this.reconcileAll();
      this.timer = setTimeout(loop, this.opts.intervalMs ?? 3000);
    };
    void loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async reconcileAll(): Promise<void> {
    if (this.running) {
      this.kick = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.kick = false;
        const { rows: agents } = await this.service.db.query<AgentRow>("SELECT * FROM agents ORDER BY created_at");
        const { rows: runtimes } = await this.service.db.query<RuntimeRow>("SELECT * FROM agent_runtimes");
        const byId = new Map(runtimes.map((r) => [r.agent_id, r]));
        for (const a of agents) {
          const rt = byId.get(a.id);
          if (!rt) continue;
          try {
            await this.reconcile(a, rt);
          } catch (err) {
            this.opts.log?.("reconcile failed", { agentId: a.id, err: String(err) });
            await this.service.recordObservation(a.id, {
              state: "unknown",
              detail: `controller error: ${String((err as Error).message ?? err).slice(0, 200)}`,
              workloadRef: rt.workload_ref,
              generation: rt.generation,
              ready: false,
            });
          }
        }
        await this.service.sweepLeases();
      } while (this.kick);
    } finally {
      this.running = false;
    }
  }

  private spec(a: AgentRow, rt: RuntimeRow, generation: number, cred: { apiKey: string | null; workspaceId: string | null }): RuntimeSpec {
    const preset = this.service.config.runtimeCatalog.find((p) => p.id === rt.preset_id);
    if (!preset) throw new Error(`preset ${rt.preset_id} no longer in catalog`);
    return {
      agentId: a.id,
      generation,
      namespace: rt.namespace,
      preset,
      apiUrl: this.opts.apiUrlForRuntimes,
      storageRef: rt.storage_ref ?? `agent-${a.id}-workspace`,
      displayName: a.display_name,
      jobRole: a.job_role,
      providerKey: cred.apiKey,
      providerWorkspaceId: cred.apiKey ? cred.workspaceId : null,
    };
  }

  async reconcile(a: AgentRow, rt: RuntimeRow): Promise<void> {
    const pods = await this.driver.listPods(rt.namespace, a.id);
    const wantRunning = a.desired_runtime === "running" && a.lifecycle_state !== "retired";

    if (!wantRunning) {
      for (const p of pods) if (!p.terminating) await this.driver.deletePod(rt.namespace, p.name);
      if (a.lifecycle_state === "retired") await this.driver.teardown(rt.namespace, a.id, rt.storage_ref === null);
      await this.observe(a.id, rt.generation, pods.length ? "pending" : "stopped", pods.length ? "stopping" : null, null, false);
      return;
    }

    // Old generations go away; exactly one generation is ever current.
    for (const p of pods) {
      if (p.generation !== rt.generation && !p.terminating) await this.driver.deletePod(rt.namespace, p.name);
    }

    let generation = rt.generation;
    let current = pods.find((p) => p.generation === generation && !p.terminating);
    const deadPod = current && (current.phase === "Failed" || current.phase === "Succeeded");
    const vanished = !current && rt.ready_generation === generation; // was ready, now gone (deleted, node lost...)
    if (deadPod || vanished) {
      if (current) await this.driver.deletePod(rt.namespace, current.name);
      generation = await this.service.controllerBumpGeneration(a.id, deadPod ? `pod ${current!.phase.toLowerCase()}` : "pod disappeared");
      current = undefined;
    }

    if (!current) {
      if (rt.observed_state === "failed" && rt.generation === generation) return; // wait for an explicit retry
      const cred = await this.service.runtimeCredential(a.id);
      const spec = this.spec(a, rt, generation, cred);
      await this.driver.ensureIdentity(spec, () => this.service.issueAgentToken(a.id));
      const name = await this.driver.createPod(spec);
      await this.service.markSecretApplied(a.id, generation, cred.rev);
      this.opts.log?.("created runtime", { agentId: a.id, pod: name, generation });
      await this.observe(a.id, generation, "pending", "creating", name, false);
      return;
    }

    // The agent's key changed (new key, rotation, revocation): give it a fresh
    // runtime holding the right secret — but never pull the rug mid-run.
    const preset = this.service.config.runtimeCatalog.find((p) => p.id === rt.preset_id);
    if (preset?.harness !== "script") {
      const want = await this.service.desiredSecretRev(a);
      if (want !== (rt.applied_secret_rev ?? "none") && !(await this.service.hasRunningRun(a.id))) {
        await this.service.controllerBumpGeneration(a.id, "API credential changed");
        this.kick = true;
        return;
      }
    }

    const { state, detail } = classify(current);
    if (state === "failed") {
      // Provisioning failure: report it and stop retrying until someone asks (POST runtime/start).
      await this.driver.deletePod(rt.namespace, current.name);
    }
    await this.observe(a.id, generation, state, detail, current.name, state === "running");
  }

  private async observe(agentId: string, generation: number, state: string, detail: string | null, workloadRef: string | null, ready: boolean) {
    await this.service.recordObservation(agentId, { state, detail, workloadRef, generation, ready });
  }
}

export function classify(p: PodInfo): { state: string; detail: string | null } {
  if (p.waitingReason && FATAL_WAITING.has(p.waitingReason)) {
    return { state: "failed", detail: `${p.waitingReason}: ${p.message ?? ""}`.trim() };
  }
  if (p.phase === "Running" && p.ready) return { state: "running", detail: p.restarts ? `restarts: ${p.restarts}` : null };
  if (p.phase === "Running" || p.waitingReason === "CrashLoopBackOff") {
    return { state: "restarting", detail: `${p.waitingReason ?? "not ready"}${p.restarts ? ` (restarts: ${p.restarts})` : ""}` };
  }
  if (p.phase === "Pending") return { state: "pending", detail: p.waitingReason ?? "scheduling" };
  return { state: "unknown", detail: p.phase };
}
