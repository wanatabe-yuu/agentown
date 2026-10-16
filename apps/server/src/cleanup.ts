import { PassThrough } from "node:stream";
import { type CleanerSettings, cleanupOf, scheduleDue, SWEEP_PARTS, type SweepPart, type TrashSettings, worldAssets } from "@agentown/core";
import type { Db } from "./db.ts";
import { tx } from "./db.ts";
import type { Instance } from "./instance.ts";
import type { RuntimeDriver } from "./runtime/driver.ts";
import type { Service } from "./service.ts";
import { badRequest, conflict, newId, notFound } from "./util.ts";
import type { Actor } from "@agentown/core";

/**
 * The cleaning robot and the trash can. On its schedule the robot moves what is
 * old enough into the trash: rows out of their tables (kept whole in trash_items),
 * files aside within their own volume (/workspace/.agentown-trash/<item>), archived
 * chats marked. On its own schedule the trash can deletes for good what has waited
 * there at least keepDays. Until then every item can be put back.
 */

const TRASH_DIR = "/workspace/.agentown-trash";
// ponytail: fixed batch sizes per sweep; the next sweep picks up the rest.
const ROWS_PER_TABLE = 20_000;
const PATHS_PER_TEAM = 500;
const SAFE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DONE_TASK = "('done','cancelled','failed')";

/** What history the robot sweeps: the rows of each table that are old and finished. */
const HISTORY: Array<{ table: string; key: string; label: string; where: string }> = [
  { table: "agent_events", key: "seq", label: "Activity", where: "org_id=$1 AND at < $2" },
  { table: "agent_logs", key: "seq", label: "Agent logs", where: "agent_id IN (SELECT id FROM agents WHERE org_id=$1) AND at < $2" },
  { table: "team_messages", key: "id", label: "Team messages", where: "org_id=$1 AND at < $2" },
  { table: "proposals", key: "id", label: "Finished proposals", where: "org_id=$1 AND updated_at < $2 AND status IN ('approved','rejected','applied','failed','expired','withdrawn')" },
  { table: "computer_requests", key: "id", label: "Computer requests", where: "org_id=$1 AND COALESCE(finished_at, created_at) < $2 AND status IN ('done','failed')" },
  { table: "artifacts", key: "id", label: "Files of finished runs", where: `run_id IN (SELECT r.id FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE t.org_id=$1 AND t.status IN ${DONE_TASK} AND r.finished_at < $2)` },
];

export interface PartReport {
  count: number;
  bytes: number;
}
export interface SweepReport {
  dryRun: boolean;
  parts: Record<SweepPart, PartReport>;
  /** What could not be reached this time (a computer offline, a team not running). */
  skipped: string[];
}
type Who = { actor: Actor } | { schedule: string };

const emptyParts = () => Object.fromEntries(SWEEP_PARTS.map((p) => [p, { count: 0, bytes: 0 }])) as Record<SweepPart, PartReport>;
const daysAgo = (days: number, now: Date) => new Date(now.getTime() - days * 86_400_000);
const byOf = (who: Who) => ("actor" in who ? `${who.actor.kind}:${who.actor.id}` : who.schedule);

export class Cleanup {
  private ticking: Promise<void> | null = null;

  constructor(
    private readonly instance: Instance,
    private readonly driver: RuntimeDriver | null,
  ) {}

  private get db(): Db {
    return this.instance.db;
  }

  /** The robot, the trash can, what is in it and what they did lately. */
  async view(service: Service, actor: Actor) {
    // Every agent works in the world the robot cleans; people need to see the organization.
    if (actor.kind === "human") await service.require(actor, "org.view", {});
    const { cleaner, trash } = cleanupOf(service.config.world);
    const items = await this.db.query(
      "SELECT id, run_id, part, label, count, bytes, source, trashed_at FROM trash_items WHERE org_id=$1 ORDER BY trashed_at DESC, label LIMIT 500",
      [service.orgId],
    );
    const runs = await this.db.query("SELECT id, kind, by, started_at, finished_at, report, error FROM trash_runs WHERE org_id=$1 ORDER BY started_at DESC LIMIT 20", [service.orgId]);
    return {
      cleaner,
      trash,
      items: items.rows.map((r) => ({ id: r.id, runId: r.run_id, part: r.part, label: r.label, count: r.count, bytes: Number(r.bytes), trashedAt: (r.trashed_at as Date).toISOString() })),
      runs: runs.rows.map((r) => ({ id: r.id, kind: r.kind, by: r.by, startedAt: (r.started_at as Date).toISOString(), finishedAt: r.finished_at ? (r.finished_at as Date).toISOString() : null, report: r.report, error: r.error })),
    };
  }

  /** Who may run the robot or the trash by hand: whoever may change the world. */
  private async allow(service: Service, actor: Actor, what: string) {
    await service.require(actor, "org.design", {}, { auditAs: what });
  }

  /** Sweep now (or show what a sweep would take, with dryRun). */
  async sweepNow(service: Service, actor: Actor, dryRun: boolean) {
    await this.allow(service, actor, "cleanup.sweep");
    const { cleaner, trash } = cleanupOf(service.config.world);
    if (!cleaner) throw notFound("cleaning robot");
    if (!trash) throw conflict("no_trash", "Place a trash can for the robot to empty into.");
    return this.sweep(service, cleaner.objectId, cleaner.settings, { actor }, dryRun);
  }

  async emptyNow(service: Service, actor: Actor) {
    await this.allow(service, actor, "cleanup.empty");
    const { trash } = cleanupOf(service.config.world);
    if (!trash) throw notFound("trash can");
    return this.empty(service, trash.objectId, trash.settings, { actor }, true);
  }

  /** Put one item back where it came from. */
  async restore(service: Service, actor: Actor, itemId: string) {
    await this.allow(service, actor, "cleanup.restore");
    const item = (await this.db.query("SELECT * FROM trash_items WHERE id=$1 AND org_id=$2", [itemId, service.orgId])).rows[0];
    if (!item) throw notFound("trash item");
    const src = item.source as Record<string, any>;
    if (item.part === "history" || item.part === "assets") {
      await tx(this.db, async (c) => {
        await c.query(`INSERT INTO ${src.table} SELECT * FROM jsonb_populate_recordset(null::${src.table}, $1) ON CONFLICT DO NOTHING`, [JSON.stringify(item.rows)]);
        await c.query("DELETE FROM trash_items WHERE id=$1", [itemId]);
      });
    } else if (item.part === "chats") {
      await tx(this.db, async (c) => {
        await c.query("UPDATE owner_chats SET trashed_at=NULL WHERE org_id=$1 AND id = ANY($2)", [service.orgId, src.chatIds]);
        await c.query("DELETE FROM trash_items WHERE id=$1", [itemId]);
      });
    } else {
      const script = `cd /workspace && t=${TRASH_DIR}/${itemId} && [ -f "$t/.list" ] && while IFS= read -r p; do [ -e "$p" ] || { mkdir -p "$(dirname "$p")" && mv "$t/$p" "$p"; }; done < "$t/.list"; rm -rf "$t"; echo restored`;
      await this.shell(service, src, script);
      await this.db.query("DELETE FROM trash_items WHERE id=$1", [itemId]);
    }
    await service.audit(this.db, actor, "cleanup.restore", itemId, true, "put back from the trash", { part: item.part, label: item.label, count: item.count });
    return { restored: itemId };
  }

  // ---------------------------------------------------------------- schedules

  /** Run every robot and trash can whose time has come (called every minute). */
  tick(now = new Date()): Promise<void> {
    return (this.ticking ??= this.due(now).finally(() => (this.ticking = null)));
  }

  private async due(now: Date) {
    for (const orgId of await this.instance.activeOrgIds()) {
      let service: Service;
      try {
        service = await this.instance.org(orgId);
      } catch {
        continue;
      }
      if (service.runState !== "running") continue;
      const { cleaner, trash } = cleanupOf(service.config.world);
      const last = async (kind: string) =>
        (await this.db.query<{ local_day: string | null }>("SELECT local_day FROM trash_runs WHERE org_id=$1 AND kind=$2 AND by='schedule' ORDER BY started_at DESC LIMIT 1", [orgId, kind])).rows[0]?.local_day ?? null;
      try {
        const sweepDay = cleaner?.settings.enabled && trash ? scheduleDue(cleaner.settings.schedule, now, await last("sweep")) : null;
        if (sweepDay) await this.sweep(service, cleaner!.objectId, cleaner!.settings, { schedule: "schedule" }, false, sweepDay, now);
        const emptyDay = trash?.settings.enabled ? scheduleDue(trash.settings.schedule, now, await last("empty")) : null;
        if (emptyDay) await this.empty(service, trash!.objectId, trash!.settings, { schedule: "schedule" }, false, emptyDay, now);
      } catch (err) {
        console.warn(`[cleanup] ${orgId}: ${(err as Error).message}`);
      }
    }
  }

  // ---------------------------------------------------------------- the robot

  private async sweep(service: Service, objectId: string, settings: CleanerSettings, who: Who, dryRun: boolean, localDay: string | null = null, now = new Date()): Promise<SweepReport & { runId: string | null }> {
    const report: SweepReport = { dryRun, parts: emptyParts(), skipped: [] };
    const runId = dryRun ? null : newId("sweep");
    const orgId = service.orgId;
    if (runId) {
      await this.db.query("INSERT INTO trash_runs(id, org_id, kind, by, local_day) VALUES ($1,$2,'sweep',$3,$4)", [runId, orgId, byOf(who), localDay]);
      await service.objectBusy(objectId, "sweeping", 120).catch(() => {});
    }
    const add = async (part: SweepPart, label: string, count: number, bytes: number, source: unknown, rows: unknown = null, id = newId("trash")) => {
      if (!count) return;
      report.parts[part].count += count;
      report.parts[part].bytes += bytes;
      if (runId) {
        await this.db.query("INSERT INTO trash_items(id, org_id, run_id, part, label, count, bytes, source, rows) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
          id, orgId, runId, part, label, count, bytes, JSON.stringify(source), rows === null ? null : JSON.stringify(rows),
        ]);
      }
    };
    let error: string | null = null;
    try {
      if (settings.history.enabled) {
        const cutoff = daysAgo(settings.history.days, now);
        for (const h of HISTORY) {
          const pick = `SELECT ${h.key} FROM ${h.table} WHERE ${h.where} ORDER BY ${h.key} LIMIT ${ROWS_PER_TABLE}`;
          if (dryRun) {
            const r = (await this.db.query(`SELECT count(*)::int AS n, COALESCE(sum(pg_column_size(x.*)),0)::bigint AS b FROM ${h.table} x WHERE ${h.key} IN (${pick})`, [orgId, cutoff])).rows[0];
            report.parts.history.count += r.n;
            report.parts.history.bytes += Number(r.b);
            continue;
          }
          // Moved in one statement: the rows leave their table and land in the trash together.
          const r = (await this.db.query(
            `WITH moved AS (DELETE FROM ${h.table} WHERE ${h.key} IN (${pick}) RETURNING *)
             INSERT INTO trash_items(id, org_id, run_id, part, label, count, bytes, source, rows)
             SELECT $3, $1, $4, 'history', $5, count(*), COALESCE(sum(pg_column_size(m.*)),0), $6, jsonb_agg(to_jsonb(m)) FROM moved m HAVING count(*) > 0
             RETURNING count, bytes`,
            [orgId, cutoff, newId("trash"), runId, h.label, JSON.stringify({ table: h.table })],
          )).rows[0];
          if (r) {
            report.parts.history.count += r.count;
            report.parts.history.bytes += Number(r.bytes);
          }
        }
      }
      if (settings.chats.enabled) {
        const cutoff = daysAgo(settings.chats.days, now);
        const sql = dryRun
          ? "SELECT id, pg_column_size(context) AS b FROM owner_chats WHERE org_id=$1 AND archived_at < $2 AND trashed_at IS NULL"
          : "UPDATE owner_chats SET trashed_at=now() WHERE org_id=$1 AND archived_at < $2 AND trashed_at IS NULL RETURNING id, pg_column_size(context) AS b";
        const rows = (await this.db.query<{ id: string; b: number }>(sql, [orgId, cutoff])).rows;
        await add("chats", "Archived chats", rows.length, rows.reduce((n, r) => n + Number(r.b), 0), { chatIds: rows.map((r) => r.id) });
      }
      if (settings.assets.enabled) {
        const used = worldAssets(service.config.world);
        const cutoff = daysAgo(settings.assets.days, now);
        const where = "org_id=$1 AND created_at < $2 AND NOT (id = ANY($3))";
        if (dryRun) {
          const r = (await this.db.query(`SELECT count(*)::int AS n, COALESCE(sum(size),0)::bigint AS b FROM assets WHERE ${where}`, [orgId, cutoff, used])).rows[0];
          report.parts.assets.count += r.n;
          report.parts.assets.bytes += Number(r.b);
        } else {
          const r = (await this.db.query(
            `WITH moved AS (DELETE FROM assets WHERE ${where} RETURNING *)
             INSERT INTO trash_items(id, org_id, run_id, part, label, count, bytes, source, rows)
             SELECT $4, $1, $5, 'assets', 'Unused art', count(*), COALESCE(sum(m.size),0), '{"table":"assets"}', jsonb_agg(to_jsonb(m)) FROM moved m HAVING count(*) > 0
             RETURNING count, bytes`,
            [orgId, cutoff, used, newId("trash"), runId],
          )).rows[0];
          if (r) {
            report.parts.assets.count += r.count;
            report.parts.assets.bytes += Number(r.bytes);
          }
        }
      }
      if (settings.workspace.enabled) await this.sweepWorkspaces(service, settings.workspace.days, now, dryRun, report, add);
      if (settings.downloads.enabled) await this.sweepComputers(service, settings.downloads.days, dryRun, report, add);
    } catch (err) {
      error = (err as Error).message;
    }
    if (runId) {
      await this.db.query("UPDATE trash_runs SET finished_at=now(), report=$2, error=$3 WHERE id=$1", [runId, JSON.stringify(report), error]);
      await this.prune(orgId);
      await service.audit(this.db, "actor" in who ? who.actor : `object:${objectId}`, "cleanup.sweep", objectId, true, error ? `swept with an error: ${error}` : "swept into the trash", report as unknown as Record<string, unknown>);
      await service.objectBusy(objectId, "sweeping", 15).catch(() => {});
    }
    if (error) throw badRequest(`the robot stopped: ${error}`);
    return { ...report, runId };
  }

  /** Task outputs of finished tasks and retired members' folders, per team volume. */
  private async sweepWorkspaces(service: Service, days: number, now: Date, dryRun: boolean, report: SweepReport, add: (part: SweepPart, label: string, count: number, bytes: number, source: unknown, rows?: unknown, id?: string) => Promise<void>) {
    const teams = (await this.db.query<{ team_id: string; namespace: string; workload_ref: string | null }>(
      "SELECT team_id, namespace, workload_ref FROM team_runtimes WHERE org_id=$1",
      [service.orgId],
    )).rows;
    for (const team of teams) {
      const old = (await this.db.query<{ agent_id: string; task_id: string }>(
        `SELECT DISTINCT r.agent_id, r.task_id FROM task_runs r JOIN tasks t ON t.id=r.task_id JOIN agents a ON a.id=r.agent_id
          WHERE t.org_id=$1 AND COALESCE(a.team_id, a.department_id)=$2 AND t.status IN ${DONE_TASK} AND t.updated_at < $3 LIMIT ${PATHS_PER_TEAM}`,
        [service.orgId, team.team_id, daysAgo(days, now)],
      )).rows;
      const retired = (await this.db.query<{ id: string }>(
        "SELECT id FROM agents WHERE org_id=$1 AND COALESCE(team_id, department_id)=$2 AND lifecycle_state='retired' AND retired_at < $3",
        [service.orgId, team.team_id, daysAgo(days, now)],
      )).rows;
      const paths = [...old.map((r) => [r.agent_id, r.task_id]).filter((x) => x.every((s) => SAFE.test(s))).map(([a, t]) => `members/${a}/tasks/${t}`), ...retired.filter((r) => SAFE.test(r.id)).map((r) => `members/${r.id}`)];
      if (!paths.length) continue;
      if (!team.workload_ref || !this.driver) {
        report.skipped.push(`team ${team.team_id} is not running`);
        continue;
      }
      const id = newId("trash");
      const out = await this.exec(team.namespace, team.workload_ref, ["/bin/sh", "-c", MOVE_SCRIPT, "sh", dryRun ? "dry" : "move", `${TRASH_DIR}/${id}`, ...paths]).catch((err: Error) => {
        report.skipped.push(`team ${team.team_id}: ${err.message}`);
        return null;
      });
      const r = out && parseMoved(out);
      if (r) await add("workspace", `Task outputs · ${team.team_id}`, r.count, r.bytes, { kind: "team", teamId: team.team_id }, null, id);
    }
  }

  /** Downloads and browser cache on the org's computers that are connected now. */
  private async sweepComputers(service: Service, days: number, dryRun: boolean, report: SweepReport, add: (part: SweepPart, label: string, count: number, bytes: number, source: unknown, rows?: unknown, id?: string) => Promise<void>) {
    const computers = this.instance.computers;
    if (!computers) return;
    for (const objectId of computers.connected(service.orgId)) {
      const id = newId("trash");
      const list = `{ find home/Downloads -mindepth 1 -maxdepth 1 -mtime +${days} 2>/dev/null; find profile \\( -name Cache -o -name 'Code Cache' -o -name GPUCache \\) -type d -prune -print0 2>/dev/null | xargs -0 -I{} find {} -type f -mtime +${days} 2>/dev/null; }`;
      const script = `cd /workspace && set -- ${dryRun ? "dry" : "move"} ${TRASH_DIR}/${id} && ${list} > /tmp/agentown-sweep && ${MOVE_LIST}`;
      const out = await computers.shell(service.orgId, objectId, script).catch((err: Error) => {
        report.skipped.push(`computer ${objectId}: ${err.message}`);
        return null;
      });
      const r = out && parseMoved(out.output);
      if (r) await add("downloads", `Downloads & cache · ${objectId}`, r.count, r.bytes, { kind: "computer", objectId }, null, id);
    }
  }

  // ---------------------------------------------------------------- the trash can

  private async empty(service: Service, objectId: string, settings: TrashSettings, who: Who, everything: boolean, localDay: string | null = null, now = new Date()) {
    const orgId = service.orgId;
    const runId = newId("empty");
    await this.db.query("INSERT INTO trash_runs(id, org_id, kind, by, local_day) VALUES ($1,$2,'empty',$3,$4)", [runId, orgId, byOf(who), localDay]);
    await service.objectBusy(objectId, "emptying", 60).catch(() => {});
    // Emptying by hand takes everything; on its schedule only what has waited keepDays.
    const cutoff = everything ? now : daysAgo(settings.keepDays, now);
    const items = (await this.db.query("SELECT * FROM trash_items WHERE org_id=$1 AND trashed_at <= $2", [orgId, cutoff])).rows;
    const report = { deleted: 0, bytes: 0, kept: [] as string[] };
    for (const item of items) {
      const src = item.source as Record<string, any>;
      try {
        if (item.part === "workspace" || item.part === "downloads") await this.shell(service, src, `rm -rf ${TRASH_DIR}/${item.id}; echo gone`);
        await tx(this.db, async (c) => {
          if (item.part === "chats") await c.query("DELETE FROM owner_chats WHERE org_id=$1 AND id = ANY($2) AND trashed_at IS NOT NULL", [orgId, src.chatIds]);
          await c.query("DELETE FROM trash_items WHERE id=$1", [item.id]);
        });
        report.deleted += item.count;
        report.bytes += Number(item.bytes);
      } catch (err) {
        // Its computer or team is away: it waits for the next emptying.
        report.kept.push(`${item.label}: ${(err as Error).message}`);
      }
    }
    await this.db.query("UPDATE trash_runs SET finished_at=now(), report=$2 WHERE id=$1", [runId, JSON.stringify(report)]);
    await this.prune(orgId);
    await service.audit(this.db, "actor" in who ? who.actor : `object:${objectId}`, "cleanup.empty", objectId, true, "emptied the trash", report);
    return { ...report, runId };
  }

  /** Keep the last 50 runs of each kind. */
  private async prune(orgId: string) {
    await this.db.query(
      "DELETE FROM trash_runs WHERE org_id=$1 AND id IN (SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY kind ORDER BY started_at DESC) AS n FROM trash_runs WHERE org_id=$1) x WHERE n > 50)",
      [orgId],
    );
  }

  // ---------------------------------------------------------------- shells

  /** A command where a file item lives: its team's runtime or its computer. */
  private async shell(service: Service, src: Record<string, any>, script: string): Promise<string> {
    if (src.kind === "computer") {
      if (!this.instance.computers) throw new Error("computers are not running");
      return (await this.instance.computers.shell(service.orgId, src.objectId, script)).output;
    }
    const rt = (await this.db.query<{ namespace: string; workload_ref: string | null }>("SELECT namespace, workload_ref FROM team_runtimes WHERE org_id=$1 AND team_id=$2", [service.orgId, src.teamId])).rows[0];
    if (!rt?.workload_ref || !this.driver) throw new Error(`team ${src.teamId} is not running`);
    return this.exec(rt.namespace, rt.workload_ref, ["/bin/sh", "-c", script]);
  }

  /** Run a command in a pod and collect what it prints. */
  private exec(namespace: string, pod: string, command: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const stdout = Object.assign(new PassThrough(), { columns: 200, rows: 50 });
      let out = "";
      stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
      const late = setTimeout(() => reject(new Error("the runtime did not answer")), 120_000);
      this.driver!.exec(namespace, pod, command, {
        stdin: new PassThrough(),
        stdout,
        onExit: (s) => {
          clearTimeout(late);
          if (s.status && s.status !== "Success") reject(new Error(s.message || s.status));
          else resolve(out);
        },
      }).catch((err) => {
        clearTimeout(late);
        reject(err);
      });
    });
  }
}

// Moves (or, with "dry", only measures) paths relative to /workspace into the trash
// directory, remembering them in .list so they can go back. Prints "moved <count> <kib>".
// $1 dry|move, $2 trash dir, then the paths. Paths come as arguments, never through the shell.
const MOVE_SCRIPT = `cd /workspace || exit 1; mode=$1; t=$2; shift 2; n=0; k=0
for p in "$@"; do [ -e "$p" ] || continue
  s=$(du -sk "$p" | cut -f1); n=$((n+1)); k=$((k+s))
  if [ "$mode" = move ]; then mkdir -p "$t/$(dirname "$p")" && mv "$p" "$t/$p" && printf '%s\\n' "$p" >> "$t/.list"; fi
done; echo "moved $n $k"`;
// The same for a list of paths in /tmp/agentown-sweep (from find), with $1 and $2 set.
const MOVE_LIST = `n=0; k=0; while IFS= read -r p; do [ -e "$p" ] || continue
  s=$(du -sk "$p" | cut -f1); n=$((n+1)); k=$((k+s))
  if [ "$1" = move ]; then mkdir -p "$2/$(dirname "$p")" && mv "$p" "$2/$p" && printf '%s\\n' "$p" >> "$2/.list"; fi
done < /tmp/agentown-sweep; rm -f /tmp/agentown-sweep; echo "moved $n $k"`;

function parseMoved(out: string): { count: number; bytes: number } | null {
  const m = /moved (\d+) (\d+)/.exec(out);
  return m ? { count: Number(m[1]), bytes: Number(m[2]) * 1024 } : null;
}
