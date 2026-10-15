import type { Instance } from "../instance.ts";
import type { RuntimeRow, Service, Share } from "../service.ts";
import { NamespaceNotReady, type PodInfo, quantity, type RuntimeDriver, type RuntimeSpec } from "./driver.ts";

type TeamPlan = Awaited<ReturnType<Service["teamPlans"]>>[number];

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
 * Reconciles desired team state (DB) with real workloads (driver): one runtime
 * per team, sized for its members. The DB only says "running" once the driver
 * reports a Ready pod of the current generation; nothing an agent says can make
 * that true.
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
        const { rows: orgs } = await this.instance.db.query<{ id: string }>("SELECT id FROM organizations WHERE config IS NOT NULL ORDER BY id");
        for (const { id: orgId } of orgs) {
          // Archived organizations still get reconciled: that is what stops their runtimes.
          // An org whose document cannot be loaded is skipped (and logged), never the whole pass.
          let service: Service;
          try {
            service = await this.instance.org(orgId, { includeArchived: true });
          } catch (err) {
            this.opts.log?.("organization unavailable", { orgId, err: String(err).slice(0, 300) });
            continue;
          }
          await this.removeLegacyPods(service);
          for (const plan of await service.teamPlans()) {
            try {
              await this.reconcile(service, plan);
            } catch (err) {
              const waiting = err instanceof NamespaceNotReady;
              if (!waiting) this.opts.log?.("reconcile failed", { orgId, teamId: plan.team.id, err: String(err) });
              await service.recordTeamObservation(plan, {
                state: waiting ? "pending" : "unknown",
                detail: waiting ? "waiting for cluster provisioning" : `controller error: ${String((err as Error).message ?? err).slice(0, 200)}`,
                workloadRef: plan.runtime.workload_ref,
                generation: plan.runtime.generation,
                ready: false,
              });
            }
          }
        }
        await this.instance.sweepLeases();
      } while (this.kick);
    } finally {
      this.running = false;
    }
  }

  /** Runtimes from before teams: one pod per agent. Remove them once; the agent now runs in its team runtime. */
  private async removeLegacyPods(service: Service) {
    const { rows } = await service.db.query<RuntimeRow>(
      "SELECT r.* FROM agent_runtimes r JOIN agents a ON a.id=r.agent_id WHERE a.org_id=$1 AND r.legacy_pod",
      [service.orgId],
    );
    for (const rt of rows) {
      if (await service.hasRunningRun(rt.agent_id)) continue; // never pull an old runtime out from under a run
      try {
        for (const p of await this.driver.listPods(rt.namespace, rt.agent_id)) if (!p.terminating) await this.driver.deletePod(rt.namespace, p.name);
        await this.driver.teardown(rt.namespace, rt.agent_id, false);
        await service.markLegacyPodRemoved(rt.agent_id);
      } catch (err) {
        if (!(err instanceof NamespaceNotReady)) this.opts.log?.("legacy runtime cleanup failed", { agentId: rt.agent_id, err: String(err) });
        else await service.markLegacyPodRemoved(rt.agent_id);
      }
    }
  }

  async reconcile(service: Service, plan: TeamPlan): Promise<void> {
    for (const m of plan.members) {
      const rt = await service.getRuntimeRow(m.id);
      if (rt.pending_preset_id && await service.applyPendingRuntimeUpgrade(m.id)) this.kick = true;
    }
    await service.syncMemberPresets(plan.members, plan.preset.id);
    const rt = plan.runtime;
    const observe = (generation: number, state: string, detail: string | null, workloadRef: string | null, ready: boolean, resources?: Share) =>
      service.recordTeamObservation(plan, { state, detail, workloadRef, generation, ready, ...(resources ? { resources } : {}) });
    const pods = await this.driver.listPods(rt.namespace, rt.runtime_id);

    if (!plan.wanted) {
      for (const p of pods) if (!p.terminating) await this.driver.deletePod(rt.namespace, p.name);
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
      generation = await service.bumpTeamGeneration(plan.team.id, deadPod ? `runtime ${current!.phase.toLowerCase()}` : "runtime disappeared");
      current = undefined;
    }

    if (!current) {
      if (rt.observed_state === "failed" && rt.generation === generation) return; // wait for an explicit retry
      if (plan.preset.id !== rt.preset_id) await service.setTeamPreset(plan.team.id, plan.preset.id);
      const spec = this.spec(plan, generation);
      await this.driver.ensureIdentity(spec, () => service.issueTeamToken(plan.team.id));
      const name = await this.driver.createPod(spec);
      this.opts.log?.("created runtime", { teamId: plan.team.id, pod: name, generation, cpu: spec.resources.cpu, memory: spec.resources.memory });
      await observe(generation, "pending", "creating", name, false, plan.resources);
      for (const m of plan.members) await service.refreshMemberConnection(m);
      return;
    }

    // A member's key changed: only that member restarts, between its runs.
    for (const m of plan.members) await service.refreshMemberConnection(m);

    // Scaling: a pod's size is fixed once it runs, so a resize (members added,
    // removed or re-declared) or a preset change is a new generation. Never mid-run:
    // until the team is idle, new members already run in the current runtime.
    const applied = rt.applied_resources;
    const resize = !!applied && (applied.cpu !== plan.resources.cpu || applied.memory !== plan.resources.memory);
    const represet = plan.preset.id !== rt.preset_id;
    if (resize || represet) {
      if (!(await service.teamHasRunningRun(plan.team.id))) {
        const why = represet ? `runtime preset ${rt.preset_id} -> ${plan.preset.id}` : `resize ${applied!.cpu}m/${applied!.memory}Mi -> ${plan.resources.cpu}m/${plan.resources.memory}Mi`;
        await service.bumpTeamGeneration(plan.team.id, why);
        this.kick = true;
        return;
      }
    }

    const { state, detail } = classify(current);
    if (state === "failed") {
      // Provisioning failure: report it and stop retrying until someone asks (POST runtime/start).
      await this.driver.deletePod(rt.namespace, current.name);
    }
    const pending = resize || represet ? `${represet ? "preset change" : `resize to ${plan.resources.cpu}m/${plan.resources.memory}Mi`} after current work` : null;
    await observe(generation, state, [detail, pending].filter(Boolean).join(" · ") || null, current.name, state === "running");
  }

  private spec(plan: TeamPlan, generation: number): RuntimeSpec {
    return {
      runtimeId: plan.runtime.runtime_id,
      teamId: plan.team.id,
      generation,
      namespace: plan.runtime.namespace,
      preset: plan.preset,
      resources: quantity(plan.resources),
      apiUrl: this.opts.apiUrlForRuntimes,
      storageRef: plan.runtime.storage_ref,
      displayName: plan.team.name,
    };
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
