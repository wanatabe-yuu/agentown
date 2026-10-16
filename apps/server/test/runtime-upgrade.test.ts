import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { EventBus } from "../src/bus.ts";
import { createPool, migrate } from "../src/db.ts";
import { Instance } from "../src/instance.ts";
import { RuntimeController } from "../src/runtime/controller.ts";
import { SecretBox } from "../src/secrets.ts";
import { FakeDriver } from "./helpers.ts";

const shipped = parse(readFileSync(new URL("../../../config/agentown.yaml", import.meta.url), "utf8"));
const legacy = {
  ...shipped,
  agentTemplates: shipped.agentTemplates.map((t: { runtimePreset: string }) => ({
    ...t, runtimePreset: t.runtimePreset === "claude-v1" ? "script-v1" : t.runtimePreset,
  })),
};
const { organization: _org, runtimeCatalog: _catalog, ...legacyDoc } = legacy;
// A customization the upgrade must keep, including the template order.
legacyDoc.departments = legacyDoc.departments.map((d: { id: string }) => d.id === "eng" ? { ...d, name: "Custom Engineering" } : d);

describe("legacy script runtime upgrade", () => {
  let db: ReturnType<typeof createPool>;
  let driver: FakeDriver;
  const instance = (config = legacy) => new Instance(db, stringify(config), new EventBus(), SecretBox.forTests(), async () => [], new URL("./fixtures/templates", import.meta.url).pathname);

  beforeEach(async () => {
    db = createPool(process.env.DATABASE_URL_TEST ?? "postgres://agentown:agentown@127.0.0.1:5432/agentown_test");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(db, 8);
    await db.query("INSERT INTO organizations(id, name, config) VALUES ('agentown','Agentown',$1), ('archive','Archive',$1)", [JSON.stringify(legacyDoc)]);
    await db.query("UPDATE organizations SET archived_at=now() WHERE id='archive'");
    await db.query("INSERT INTO org_members(org_id,user_id,is_owner,created_by) VALUES ('agentown','owner',true,'test')");
    await db.query("INSERT INTO templates(id,name,doc,owner_user_id) VALUES ('saved','Saved',$1,'owner')", [JSON.stringify(legacyDoc)]);
    for (const [id, org, lifecycle, desired, preset] of [
      ["idle", "agentown", "active", "running", "script-v1"],
      ["busy", "agentown", "active", "running", "script-v1"],
      ["stopped", "archive", "active", "stopped", "script-v1"],
      ["retired", "archive", "retired", "stopped", "script-v1"],
      ["dedicated", "agentown", "active", "running", "claude-dedicated-v1"],
    ]) {
      await db.query(
        `INSERT INTO agents(id,org_id,department_id,display_name,job_role,template_id,lifecycle_state,desired_runtime,created_by,seat)
         VALUES ($1,$2,'eng',$1,'engineer','engineer-v1',$3,$4,'test',0)`, [id, org, lifecycle, desired],
      );
      await db.query(
        `INSERT INTO agent_runtimes(agent_id,preset_id,generation,namespace,storage_ref,ready_generation,observed_state)
         VALUES ($1,$2,3,'agentown-eng',$3,3,'running')`, [id, preset, `workspace-${id}`],
      );
    }
    await db.query(`
      UPDATE agents SET model='custom-model',effort='medium',instructions='Keep these instructions',max_turns=12 WHERE id='idle';
      UPDATE agent_runtimes SET observed_state='failed' WHERE agent_id='idle';
      INSERT INTO tasks(id,org_id,title,status,assignee_agent_id,created_by,spec)
        VALUES ('work','agentown','In-flight work','in_progress','busy','test','{"kind":"playbook","playbook":"noop","args":{}}');
      INSERT INTO task_runs(id,task_id,agent_id,attempt,idempotency_key,runtime_generation,lease_expires_at,status)
        VALUES ('run','work','busy',1,'work:1',3,now()+interval '10 minutes','running');
    `);
    driver = new FakeDriver();
  });
  afterEach(async () => { await db?.end(); });

  async function podFor(inst: Instance, id: string) {
    const service = await inst.org("agentown");
    const a = await service.getAgentRow(id);
    const rt = await service.getRuntimeRow(id);
    // A runtime from before teams: one pod per agent, labelled with the agent id.
    const preset = inst.runtimeCatalog.find((p) => p.id === rt.preset_id)!;
    await driver.createPod({ runtimeId: id, teamId: a.department_id, generation: rt.generation, namespace: rt.namespace,
      preset, resources: preset.resources, apiUrl: "http://test", storageRef: rt.storage_ref!, displayName: a.display_name });
  }

  it("queues old script runtimes without changing their generation or depending on the catalog", async () => {
    await migrate(db);
    expect((await db.query("SELECT agent_id,preset_id,pending_preset_id,generation FROM agent_runtimes ORDER BY agent_id")).rows).toEqual([
      { agent_id: "busy", preset_id: "script-v1", pending_preset_id: "claude-v1", generation: 3 },
      { agent_id: "dedicated", preset_id: "claude-dedicated-v1", pending_preset_id: null, generation: 3 },
      { agent_id: "idle", preset_id: "script-v1", pending_preset_id: "claude-v1", generation: 3 },
      { agent_id: "retired", preset_id: "script-v1", pending_preset_id: "claude-v1", generation: 3 },
      { agent_id: "stopped", preset_id: "script-v1", pending_preset_id: "claude-v1", generation: 3 },
    ]);
    await migrate(db);
    expect((await db.query("SELECT generation FROM agent_runtimes WHERE agent_id='idle'")).rows[0].generation).toBe(3);
  });

  it("upgrades documents and idle runtimes once, then replaces a busy runtime after its run finishes", async () => {
    await migrate(db);
    const inst = instance();
    await podFor(inst, "idle");
    await podFor(inst, "busy");
    await podFor(inst, "dedicated");
    await inst.bootstrap({ ownerToken: "test-upgrade-owner", seedDefaultOrg: true });
    const service = await inst.org("agentown");
    const upgradedDoc = { ...legacyDoc, agentTemplates: legacyDoc.agentTemplates.map((t: { runtimePreset: string }) => ({
      ...t, runtimePreset: t.runtimePreset === "script-v1" ? "claude-v1" : t.runtimePreset,
    })) };
    expect((await db.query("SELECT config,config_revision FROM organizations ORDER BY id")).rows).toEqual([
      { config: upgradedDoc, config_revision: 2 }, { config: upgradedDoc, config_revision: 2 },
    ]);
    expect((await db.query("SELECT doc FROM templates WHERE id='saved'")).rows[0].doc).toEqual(upgradedDoc);
    expect(inst.builtInTemplates.get("company")!.doc.agentTemplates).toEqual(upgradedDoc.agentTemplates);
    expect(await service.getRuntimeRow("idle")).toMatchObject({ preset_id: "claude-v1", generation: 4, pending_preset_id: null, ready_generation: null, storage_ref: "workspace-idle" });
    expect(await service.getAgentRow("idle")).toMatchObject({ credential_id: null, model: "custom-model", effort: "medium", instructions: "Keep these instructions", max_turns: 12 });
    expect(await service.getRuntimeRow("busy")).toMatchObject({ preset_id: "script-v1", generation: 3, pending_preset_id: "claude-v1" });
    expect((await db.query("SELECT a.lifecycle_state,a.desired_runtime,r.preset_id,r.generation FROM agents a JOIN agent_runtimes r ON r.agent_id=a.id WHERE a.id IN ('stopped','retired') ORDER BY a.id")).rows).toEqual([
      { lifecycle_state: "retired", desired_runtime: "stopped", preset_id: "claude-v1", generation: 4 },
      { lifecycle_state: "active", desired_runtime: "stopped", preset_id: "claude-v1", generation: 4 },
    ]);

    const controller = new RuntimeController(inst, driver, { apiUrlForRuntimes: "http://test" });
    await controller.reconcileAll();
    await controller.reconcileAll();
    // Idle agents' old per-agent pods go; the busy one keeps its pod until its run ends. All of eng shares one team runtime.
    expect([...driver.pods.values()].filter((p) => ["idle", "dedicated"].includes(p.runtimeId))).toEqual([]);
    expect([...driver.pods.values()].filter((p) => p.runtimeId === "busy").map((p) => p.generation)).toEqual([3]);
    expect([...driver.pods.values()].filter((p) => p.runtimeId.startsWith("team-eng-")).map((p) => p.env.AGENTOWN_HARNESS)).toEqual(["claude"]);
    expect(await service.claim({ kind: "agent", id: "busy" }, 3)).toMatchObject({ resumed: true, run: { id: "run" }, config: { harness: "script" } });
    await service.completeRun({ kind: "agent", id: "busy" }, "run", 3, { outcome: "succeeded" });
    // Queue another task: the old harness must wait for the migration before claiming it.
    await db.query("INSERT INTO tasks(id,org_id,title,status,assignee_agent_id,created_by,spec) SELECT 'next',org_id,'Next','assigned',assignee_agent_id,created_by,spec FROM tasks WHERE id='work'");
    expect(await service.claim({ kind: "agent", id: "busy" }, 3)).toBeNull();
    await controller.reconcileAll();
    await controller.reconcileAll();
    expect(await service.getRuntimeRow("busy")).toMatchObject({ preset_id: "claude-v1", generation: 4, ready_generation: 4, pending_preset_id: null, storage_ref: "workspace-busy" });
    expect([...driver.pods.values()].filter((p) => p.runtimeId === "busy")).toEqual([]);
    expect(await service.claim({ kind: "agent", id: "busy" }, 4)).toMatchObject({ task: { id: "next" }, config: { harness: "claude" } });
    await expect(service.claim({ kind: "agent", id: "busy" }, 3)).rejects.toMatchObject({ code: "stale_runtime" });
    expect((await db.query("SELECT status,attempt FROM task_runs WHERE id='run'")).rows[0]).toEqual({ status: "succeeded", attempt: 1 });
    // A member runs in its team's runtime and takes its preset (isolation = a team of its own).
    expect((await db.query("SELECT preset_id,generation FROM agent_runtimes WHERE agent_id='dedicated'")).rows[0]).toEqual({ preset_id: "claude-v1", generation: 3 });
    await migrate(db);
    await inst.bootstrap({ seedDefaultOrg: true });
    await instance().bootstrap({ seedDefaultOrg: true });
    await controller.reconcileAll();
    expect((await db.query("SELECT generation FROM agent_runtimes WHERE agent_id='idle'")).rows[0].generation).toBe(4);
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action='runtime.upgrade'")).rows[0].n).toBe(4);
    expect((await db.query("SELECT config_revision FROM organizations WHERE id='agentown'")).rows[0].config_revision).toBe(2);
  });

  it.each(["missing", "script"])("defers an unavailable LLM target (%s), and retries when an approved one is added", async (mode) => {
    await migrate(db);
    const config = { ...legacy, runtimeCatalog: mode === "missing"
      ? legacy.runtimeCatalog.filter((p: { id: string }) => p.id !== "claude-v1")
      : legacy.runtimeCatalog.map((p: { id: string }) => p.id === "claude-v1" ? { ...p, harness: "script" } : p),
    };
    const old = instance(config);
    if (mode === "missing") expect([...old.builtInTemplates.keys()]).toEqual(["company"]);
    await old.bootstrap({ ownerToken: "test-upgrade-owner", seedDefaultOrg: true });
    await podFor(old, "idle");
    await new RuntimeController(old, driver, { apiUrlForRuntimes: "http://test" }).reconcileAll();
    expect((await db.query("SELECT preset_id,pending_preset_id,generation FROM agent_runtimes WHERE agent_id='idle'")).rows[0]).toEqual({ preset_id: "script-v1", pending_preset_id: "claude-v1", generation: 3 });
    expect((await db.query("SELECT * FROM data_migrations")).rows).toEqual([]);
    expect((await db.query("SELECT config,config_revision FROM organizations WHERE id='agentown'")).rows[0]).toEqual({ config: legacyDoc, config_revision: 1 });
    await instance().bootstrap({ seedDefaultOrg: true });
    expect((await db.query("SELECT preset_id,pending_preset_id,generation FROM agent_runtimes WHERE agent_id='idle'")).rows[0]).toEqual({ preset_id: "claude-v1", pending_preset_id: null, generation: 4 });
  });

  it("does not queue script runtimes deliberately created after the schema upgrade", async () => {
    await migrate(db);
    await instance().bootstrap({ ownerToken: "test-upgrade-owner", seedDefaultOrg: true });
    await db.query("INSERT INTO agents(id,org_id,department_id,display_name,job_role,template_id,lifecycle_state,desired_runtime,created_by,seat) SELECT 'new-script',org_id,department_id,'New script',job_role,template_id,lifecycle_state,desired_runtime,created_by,seat FROM agents WHERE id='idle'");
    await db.query("INSERT INTO agent_runtimes(agent_id,preset_id,namespace,storage_ref) VALUES ('new-script','script-v1','agentown-eng','workspace-new')");
    await migrate(db);
    await instance().bootstrap({ seedDefaultOrg: true });
    expect((await db.query("SELECT preset_id,pending_preset_id,generation FROM agent_runtimes WHERE agent_id='new-script'")).rows[0]).toEqual({ preset_id: "script-v1", pending_preset_id: null, generation: 1 });
  });

  it("serializes concurrent upgrade attempts and task claims", async () => {
    await migrate(db);
    const service = await instance().org("agentown");
    await db.query("INSERT INTO tasks(id,org_id,title,status,assignee_agent_id,created_by) VALUES ('idle-work','agentown','Queued','assigned','idle','test')");
    const results = await Promise.allSettled([
      service.applyPendingRuntimeUpgrade("idle"), service.applyPendingRuntimeUpgrade("idle"),
      service.claim({ kind: "agent", id: "idle" }, 3),
    ]);
    expect(results.slice(0, 2).filter((r) => r.status === "fulfilled" && r.value === true)).toHaveLength(1);
    expect(results.slice(0, 2).filter((r) => r.status === "fulfilled" && r.value === false)).toHaveLength(1);
    const claim = results[2];
    if (claim.status === "fulfilled") expect(claim.value).toBeNull();
    else expect(claim.reason).toMatchObject({ code: "stale_runtime" });
    expect(await service.getRuntimeRow("idle")).toMatchObject({ preset_id: "claude-v1", generation: 4, pending_preset_id: null });
    expect((await db.query("SELECT id FROM task_runs WHERE agent_id='idle'")).rows).toEqual([]);
  });

  it("leaves an unreadable organization pending without blocking other organizations", async () => {
    await migrate(db);
    await db.query("UPDATE organizations SET config=jsonb_set(config,'{departments}','[]') WHERE id='archive'");
    const inst = instance();
    await inst.bootstrap({ ownerToken: "test-upgrade-owner", seedDefaultOrg: true });
    expect((await db.query("SELECT preset_id,pending_preset_id FROM agent_runtimes WHERE agent_id='stopped'")).rows[0]).toEqual({ preset_id: "script-v1", pending_preset_id: "claude-v1" });
    expect((await db.query("SELECT preset_id FROM agent_runtimes WHERE agent_id='idle'")).rows[0].preset_id).toBe("claude-v1");
    const controller = new RuntimeController(inst, driver, { apiUrlForRuntimes: "http://test" });
    await controller.reconcileAll();
    expect([...driver.pods.values()].some((p) => p.runtimeId.startsWith("team-eng-"))).toBe(true);
  });
});
