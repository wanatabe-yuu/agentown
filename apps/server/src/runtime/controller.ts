import type { Instance } from "../instance.ts";
import type { AgentRow, RuntimeRow, Service } from "../service.ts";
import { NamespaceNotReady, type PodInfo, type RuntimeDriver, type RuntimeLlm, type RuntimeSpec } from "./driver.ts";

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
    private readonly instance: Instance,
    private readonly driver: RuntimeDriver,
    private readonly opts: ControllerOptions,
  ) {}

  start(): void {
    const loop = async () => {
      // Never let one bad pass stop the loop (or the process).
      await this.reconcileAll().catch((err) => this.opts.log?.("reconcile pass failed", { err: String(err) }));
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
        const { rows: agents } = await this.instance.db.query<AgentRow>("SELECT * FROM agents ORDER BY created_at");
        const { rows: runtimes } = await this.instance.db.query<RuntimeRow>("SELECT * FROM agent_runtimes");
        const byId = new Map(runtimes.map((r) => [r.agent_id, r]));
        for (const a of agents) {
          const rt = byId.get(a.id);
          if (!rt) continue;
          // Archived organizations still get reconciled: that is what stops their runtimes.
          // An org whose document cannot be loaded is skipped (and logged), never the whole pass.
          let service: Service;
          try {
            service = await this.instance.org(a.org_id, { includeArchived: true });
          } catch (err) {
            this.opts.log?.("organization unavailable", { orgId: a.org_id, err: String(err).slice(0, 300) });
            continue;
          }
          try {
            await this.reconcile(service, a, rt);
          } catch (err) {
            const waiting = err instanceof NamespaceNotReady;
            if (!waiting) this.opts.log?.("reconcile failed", { agentId: a.id, err: String(err) });
            await service.recordObservation(a.id, {
              state: waiting ? "pending" : "unknown",
              detail: waiting ? "waiting for cluster provisioning" : `controller error: ${String((err as Error).message ?? err).slice(0, 200)}`,
              workloadRef: rt.workload_ref,
              generation: rt.generation,
              ready: false,
            });
          }
        }
        await this.instance.sweepLeases();
      } while (this.kick);
    } finally {
      this.running = false;
    }
  }

  private spec(a: AgentRow, rt: RuntimeRow, generation: number, llm: RuntimeLlm | null): RuntimeSpec {
    const preset = this.instance.runtimeCatalog.find((p) => p.id === rt.preset_id);
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
      llm,
    };
  }

  async reconcile(service: Service, a: AgentRow, rt: RuntimeRow): Promise<void> {
    const observe = (generation: number, state: string, detail: string | null, workloadRef: string | null, ready: boolean) =>
      service.recordObservation(a.id, { state, detail, workloadRef, generation, ready });
    const pods = await this.driver.listPods(rt.namespace, a.id);
    const wantRunning = a.desired_runtime === "running" && a.lifecycle_state !== "retired";

    if (!wantRunning) {
      for (const p of pods) if (!p.terminating) await this.driver.deletePod(rt.namespace, p.name);
      if (a.lifecycle_state === "retired") await this.driver.teardown(rt.namespace, a.id, rt.storage_ref === null);
      await observe(rt.generation, pods.length ? "pending" : "stopped", pods.length ? "stopping" : null, null, false);
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
      generation = await service.controllerBumpGeneration(a.id, deadPod ? `pod ${current!.phase.toLowerCase()}` : "pod disappeared");
      current = undefined;
    }

    if (!current) {
      if (rt.observed_state === "failed" && rt.generation === generation) return; // wait for an explicit retry
      const cred = await service.runtimeCredential(a.id);
      const spec = this.spec(a, rt, generation, cred.llm);
      await this.driver.ensureIdentity(spec, () => service.issueAgentToken(a.id));
      const name = await this.driver.createPod(spec);
      await service.markSecretApplied(a.id, generation, cred.rev);
      this.opts.log?.("created runtime", { agentId: a.id, pod: name, generation });
      await observe(generation, "pending", "creating", name, false);
      return;
    }

    // The agent's key changed (new key, rotation, revocation): give it a fresh
    // runtime holding the right secret — but never pull the rug mid-run.
    const preset = this.instance.runtimeCatalog.find((p) => p.id === rt.preset_id);
    if (preset?.harness !== "script") {
      const want = await service.desiredSecretRev(a);
      if (want !== (rt.applied_secret_rev ?? "none") && !(await service.hasRunningRun(a.id))) {
        await service.controllerBumpGeneration(a.id, "API credential changed");
        this.kick = true;
        return;
      }
    }

    const { state, detail } = classify(current);
    if (state === "failed") {
      // Provisioning failure: report it and stop retrying until someone asks (POST runtime/start).
      await this.driver.deletePod(rt.namespace, current.name);
    }
    await observe(generation, state, detail, current.name, state === "running");
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
