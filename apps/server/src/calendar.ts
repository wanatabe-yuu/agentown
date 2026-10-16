import { type Actor, authorize, type CalendarJob, calendarJobSchema, cleanupOf, jobDue, localClock, weeklyOf } from "@agentown/core";
import type { Db } from "./db.ts";
import type { Instance } from "./instance.ts";
import type { Service } from "./service.ts";
import { actorRef, badRequest, newId, notFound } from "./util.ts";

/**
 * The wall calendar: every scheduled job in the organization. People put jobs on it
 * (an object doing one of its actions, or a task for an agent, weekly or once); the
 * cleaning robot's and the trash can's schedules show there too, read from the world.
 * Each time a job runs it leaves a run, kept so the calendar shows what was done.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
type Status = "running" | "done" | "failed";

export class Calendar {
  private ticking: Promise<void> | null = null;

  constructor(private readonly instance: Instance) {}

  private get db(): Db {
    return this.instance.db;
  }

  /**
   * Jobs, and what ran between two local days (inclusive, at most ~2 months). An agent
   * sees the objects' jobs and those of the agents it may see.
   */
  async view(service: Service, actor: Actor, from: string, to: string) {
    const policy = await service.kernel.permissions.load();
    if (actor.kind === "human") await service.require(actor, "org.view", {}, { policy });
    const visible = (j: CalendarJob) => actor.kind === "human" || j.who.type === "object" || authorize(actor, "org.view", { agentId: j.who.id }, policy).allowed;
    if (!DAY.test(from) || !DAY.test(to) || from > to || Date.parse(to) - Date.parse(from) > 62 * 86_400_000) throw badRequest("from and to: days like 2026-10-01, at most 62 days apart");
    const own = { rows: (await this.db.query("SELECT id, job, created_by, created_at FROM schedules WHERE org_id=$1 ORDER BY created_at, id", [service.orgId])).rows.filter((r) => visible(r.job)) };
    const shown = new Set(own.rows.map((r) => r.id as string));
    const runs = await this.db.query(
      `SELECT r.schedule_id, r.local_day, r.at, r.status, r.task_id, r.error, t.status AS task_status
         FROM schedule_runs r LEFT JOIN tasks t ON t.id = r.task_id
        WHERE r.org_id=$1 AND r.local_day BETWEEN $2 AND $3`,
      [service.orgId, from, to],
    );
    const { cleaner, trash } = cleanupOf(service.config.world);
    const builtins = [
      cleaner && { id: "builtin:sweep", builtin: "sweep", job: { title: "Sweep into the trash", who: { type: "object", id: cleaner.objectId }, repeat: weeklyOf(cleaner.settings.schedule), timeZone: cleaner.settings.schedule.timeZone, enabled: cleaner.settings.enabled } },
      trash && { id: "builtin:empty", builtin: "empty", job: { title: "Empty the trash", who: { type: "object", id: trash.objectId }, repeat: weeklyOf(trash.settings.schedule), timeZone: trash.settings.schedule.timeZone, enabled: trash.settings.enabled } },
    ].filter(Boolean) as Array<{ id: string; builtin: string; job: CalendarJob }>;
    // Every sweep and empty, by schedule or by hand, on the local day it happened.
    const done = await this.db.query("SELECT kind, local_day, started_at, finished_at, error FROM trash_runs WHERE org_id=$1 AND started_at > $2::date - 2", [service.orgId, from]);
    const builtinRuns = done.rows.flatMap((r) => {
      const b = builtins.find((x) => x.builtin === r.kind);
      const day = b ? (r.local_day ?? localClock(b.job.timeZone, r.started_at).day) : null;
      if (!b || !day || day < from || day > to) return [];
      return [{ jobId: b.id, day, at: (r.started_at as Date).toISOString(), status: (r.error ? "failed" : r.finished_at ? "done" : "running") as Status, error: r.error }];
    });
    return {
      // since: the first day it could have run (a missed run shows from then on; the robot's only from today).
      jobs: [
        ...builtins.map((b) => ({ ...b, createdBy: null, since: localClock(b.job.timeZone, new Date()).day })),
        ...own.rows.map((r) => ({ id: r.id as string, builtin: null, job: r.job as CalendarJob, createdBy: r.created_by as string, since: localClock((r.job as CalendarJob).timeZone, r.created_at).day })),
      ],
      runs: [
        ...builtinRuns,
        ...runs.rows.filter((r) => shown.has(r.schedule_id)).map((r) => ({
          jobId: r.schedule_id as string,
          day: r.local_day as string,
          at: (r.at as Date).toISOString(),
          // A task's run is done when the task is.
          status: (r.status !== "done" || !r.task_id ? r.status : r.task_status === "done" ? "done" : ["failed", "cancelled"].includes(r.task_status) ? "failed" : "running") as Status,
          taskId: r.task_id as string | null,
          error: r.error as string | null,
        })),
      ],
    };
  }

  /**
   * Who may put a job on the calendar, change or take it off: for an object's action,
   * whoever may change the world; for an agent's task, whoever may give that agent tasks
   * (an agent for itself or its reports, as its grants say).
   */
  private permissionFor(job: CalendarJob) {
    return job.who.type === "object" ? { action: "org.design" as const, target: {} } : { action: "task.create" as const, target: { agentId: job.who.id, projectId: null } };
  }

  /** Whether the actor may make this change (without asking anyone). */
  async may(service: Service, actor: Actor, change: { op: "create" | "update" | "delete"; id?: string; job?: unknown }): Promise<boolean> {
    const policy = await service.kernel.permissions.load();
    const jobs = [change.job ? calendarJobSchema.safeParse(change.job).data : undefined, change.id ? await this.row(service, change.id).then((r) => r?.job, () => undefined) : undefined].filter(Boolean) as CalendarJob[];
    return jobs.every((j) => {
      const p = this.permissionFor(j);
      return authorize(actor, p.action, p.target, policy).allowed;
    });
  }

  private async row(service: Service, id: string) {
    return (await this.db.query<{ job: CalendarJob; created_by: string }>("SELECT job, created_by FROM schedules WHERE id=$1 AND org_id=$2", [id, service.orgId])).rows[0];
  }

  private async allow(service: Service, actor: Actor, job: CalendarJob, what: string) {
    const p = this.permissionFor(job);
    await service.require(actor, p.action, p.target, { auditAs: what, detail: { title: job.title } });
  }

  /** A job that makes sense: its object has that action, its agent is still here. */
  private async check(service: Service, input: unknown): Promise<CalendarJob> {
    const r = calendarJobSchema.safeParse(input);
    if (!r.success) throw badRequest(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const job = r.data;
    if (job.who.type === "object") {
      const world = service.config.world;
      const object = world?.objects.find((o) => o.id === job.who.id);
      const kind = object && world!.kinds[object.kind];
      if (!kind) throw notFound("world object");
      if (!kind.actions.some((a) => a.id === job.action)) throw badRequest(`${object!.label ?? kind.name} has no action ${job.action}; it can: ${kind.actions.map((a) => a.id).join(", ") || "nothing"}`);
    } else {
      const { rows } = await this.db.query("SELECT 1 FROM agents WHERE org_id=$1 AND id=$2 AND lifecycle_state <> 'retired'", [service.orgId, job.who.id]);
      if (!rows[0]) throw notFound("agent");
    }
    return job;
  }

  async create(service: Service, actor: Actor, input: unknown) {
    const job = await this.check(service, input);
    await this.allow(service, actor, job, "schedule.create");
    const id = newId("sch");
    await this.db.query("INSERT INTO schedules(id, org_id, job, created_by) VALUES ($1,$2,$3,$4)", [id, service.orgId, JSON.stringify(job), actorRef(actor)]);
    return { id, job };
  }

  /** Changing a job makes it the changer's: its tasks are given in their name from then on. */
  async update(service: Service, actor: Actor, id: string, input: unknown) {
    const old = await this.row(service, id);
    if (!old) throw notFound("schedule");
    const job = await this.check(service, input);
    await this.allow(service, actor, old.job, "schedule.update");
    await this.allow(service, actor, job, "schedule.update");
    await this.db.query("UPDATE schedules SET job=$3, created_by=$4, updated_at=now() WHERE id=$1 AND org_id=$2", [id, service.orgId, JSON.stringify(job), actorRef(actor)]);
    return { id, job };
  }

  async remove(service: Service, actor: Actor, id: string) {
    const old = await this.row(service, id);
    if (!old) throw notFound("schedule");
    await this.allow(service, actor, old.job, "schedule.delete");
    await this.db.query("DELETE FROM schedules WHERE id=$1 AND org_id=$2", [id, service.orgId]);
    return { deleted: id };
  }

  /** Run every job whose time has come (called every minute); each runs once per local day. */
  tick(now = new Date()): Promise<void> {
    return (this.ticking ??= this.due(now).finally(() => (this.ticking = null)));
  }

  private async due(now: Date) {
    const { rows } = await this.db.query("SELECT id, org_id, job, created_by FROM schedules ORDER BY org_id, id");
    for (const r of rows) {
      const job = r.job as CalendarJob;
      const day = job.enabled ? jobDue(job, now) : null;
      if (!day) continue;
      let service: Service;
      try {
        service = await this.instance.org(r.org_id);
      } catch {
        continue;
      }
      if (service.runState !== "running") continue;
      const runId = newId("srun");
      const claimed = await this.db.query("INSERT INTO schedule_runs(id, org_id, schedule_id, local_day, status) VALUES ($1,$2,$3,$4,'running') ON CONFLICT (schedule_id, local_day) DO NOTHING RETURNING id", [runId, r.org_id, r.id, day]);
      if (!claimed.rowCount) continue;
      try {
        const taskId = await this.run(service, r.id, job, r.created_by, day);
        await this.db.query("UPDATE schedule_runs SET status='done', task_id=$2 WHERE id=$1", [runId, taskId]);
      } catch (err) {
        await this.db.query("UPDATE schedule_runs SET status='failed', error=$2 WHERE id=$1", [runId, (err as Error).message.slice(0, 500)]);
      }
    }
  }

  /** Do the job: the object does its action, or the agent gets a task from whoever set it. */
  private async run(service: Service, id: string, job: CalendarJob, by: string, day: string): Promise<string | null> {
    if (job.who.type === "object") {
      const object = service.config.world?.objects.find((o) => o.id === job.who.id);
      const action = object && service.config.world!.kinds[object.kind]?.actions.find((a) => a.id === job.action);
      if (!action) throw notFound("the object or its action");
      await service.objectBusy(job.who.id, action.state, action.seconds);
      return null;
    }
    // The task is given in the name of whoever set the job, with their permissions today.
    const actor = await service.kernel.identity.parseActorRef(by);
    const still = actor.kind === "human"
      ? await this.db.query("SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND disabled_at IS NULL", [service.orgId, actor.id])
      : await this.db.query("SELECT 1 FROM agents WHERE org_id=$1 AND id=$2 AND lifecycle_state <> 'retired'", [service.orgId, actor.id]);
    if (!still.rows[0]) throw new Error("whoever set this job is no longer in the organization");
    const out = await service.createTask(actor, {
      title: job.title,
      description: job.prompt,
      assigneeAgentId: job.who.id,
      requiresReview: false,
      spec: { kind: "prompt" },
      idempotencyKey: `schedule-${id}-${day}`,
    });
    return out.task.id;
  }
}
