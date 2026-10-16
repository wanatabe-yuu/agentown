import pg from "pg";

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export async function tx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE organizations (
    id text PRIMARY KEY,
    name text NOT NULL,
    policy_revision bigint NOT NULL DEFAULT 1
  );
  CREATE TABLE departments (
    id text PRIMARY KEY,
    name text NOT NULL,
    color text NOT NULL
  );
  CREATE TABLE projects (
    id text PRIMARY KEY,
    name text NOT NULL
  );
  CREATE TABLE agents (
    id text PRIMARY KEY,
    department_id text NOT NULL REFERENCES departments(id),
    display_name text NOT NULL,
    job_role text NOT NULL,
    template_id text NOT NULL,
    reports_to text REFERENCES agents(id),
    lifecycle_state text NOT NULL,           -- provisioning | active | retired
    desired_runtime text NOT NULL,           -- running | stopped
    accepting_work boolean NOT NULL DEFAULT true,
    created_by text NOT NULL,
    spawn_key text UNIQUE,                   -- idempotency: "<actor>:<key>"
    seat int NOT NULL,
    work_state text NOT NULL DEFAULT 'offline',
    work_detail text,
    work_updated_at timestamptz,
    last_heartbeat_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    retired_at timestamptz
  );
  CREATE TABLE agent_runtimes (
    agent_id text PRIMARY KEY REFERENCES agents(id),
    preset_id text NOT NULL,
    generation int NOT NULL DEFAULT 1,
    namespace text NOT NULL,
    workload_ref text,
    storage_ref text,
    observed_state text NOT NULL DEFAULT 'none',
    observed_detail text,
    observed_at timestamptz,
    ready_generation int
  );
  CREATE TABLE grants (
    id text PRIMARY KEY,
    principal_id text NOT NULL REFERENCES agents(id),
    action text NOT NULL,
    scope jsonb NOT NULL,
    constraints jsonb NOT NULL DEFAULT '{}',
    delegable boolean NOT NULL DEFAULT false,
    issuer text NOT NULL,
    parent_grant_id text REFERENCES grants(id),
    expires_at timestamptz,
    revoked_at timestamptz,
    revision int NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX grants_principal ON grants(principal_id);
  CREATE TABLE tokens (
    hash text PRIMARY KEY,
    principal_kind text NOT NULL,            -- human | agent
    principal_id text NOT NULL,
    label text,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
  );
  CREATE TABLE tasks (
    id text PRIMARY KEY,
    project_id text REFERENCES projects(id),
    parent_task_id text REFERENCES tasks(id),
    title text NOT NULL,
    description text NOT NULL DEFAULT '',
    acceptance_criteria text NOT NULL DEFAULT '',
    spec jsonb NOT NULL DEFAULT '{"kind":"prompt"}',
    status text NOT NULL,
    status_reason text,
    assignee_agent_id text REFERENCES agents(id),
    created_by text NOT NULL,
    requires_review boolean NOT NULL DEFAULT false,
    input_task_ids text[] NOT NULL DEFAULT '{}',
    idempotency_key text UNIQUE,
    attempt int NOT NULL DEFAULT 1,
    max_attempts int NOT NULL DEFAULT 3,
    summary text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX tasks_assignee ON tasks(assignee_agent_id, status);
  CREATE TABLE task_assignments (
    id bigserial PRIMARY KEY,
    task_id text NOT NULL REFERENCES tasks(id),
    from_agent_id text,
    to_agent_id text,
    by_actor text NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE task_runs (
    id text PRIMARY KEY,
    task_id text NOT NULL REFERENCES tasks(id),
    agent_id text NOT NULL REFERENCES agents(id),
    attempt int NOT NULL,
    idempotency_key text NOT NULL UNIQUE,    -- "<taskId>:<attempt>": one run per attempt, ever
    runtime_generation int NOT NULL,
    lease_expires_at timestamptz NOT NULL,
    status text NOT NULL,                    -- running | succeeded | failed | blocked | lost | cancelled
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    summary text,
    usage jsonb
  );
  CREATE TABLE artifacts (
    id text PRIMARY KEY,
    task_id text NOT NULL REFERENCES tasks(id),
    run_id text NOT NULL REFERENCES task_runs(id),
    agent_id text NOT NULL REFERENCES agents(id),
    name text NOT NULL,
    content_type text NOT NULL,
    content bytea NOT NULL,
    sha256 text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, name)
  );
  CREATE TABLE agent_events (
    seq bigserial PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now(),
    agent_id text,
    task_id text,
    run_id text,
    type text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'
  );
  CREATE TABLE agent_logs (
    seq bigserial PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now(),
    agent_id text NOT NULL,
    run_id text,
    stream text NOT NULL,
    line text NOT NULL
  );
  CREATE INDEX agent_logs_agent ON agent_logs(agent_id, seq);
  CREATE TABLE audit_events (
    id bigserial PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now(),
    actor text NOT NULL,
    action text NOT NULL,
    target text,
    allowed boolean NOT NULL,
    reason text,
    policy_revision bigint,
    request_id text,
    detail jsonb NOT NULL DEFAULT '{}'
  );
  CREATE TABLE terminal_sessions (
    id text PRIMARY KEY,
    actor text NOT NULL,
    agent_id text NOT NULL REFERENCES agents(id),
    generation int NOT NULL,
    ticket_hash text,
    ticket_expires_at timestamptz,
    opened_at timestamptz NOT NULL DEFAULT now(),
    attached_at timestamptz,
    closed_at timestamptz,
    close_reason text
  );
  `,
  `
  CREATE TABLE credentials (
    id text PRIMARY KEY,
    name text NOT NULL,
    provider text NOT NULL,
    ciphertext bytea NOT NULL,               -- AES-256-GCM envelope (SecretBox)
    key_hint text NOT NULL,                  -- last 4 characters, for humans
    models text[] NOT NULL DEFAULT '{}',     -- what this key can use, discovered from the provider
    departments text[],                      -- NULL = usable by agents in any department
    revision int NOT NULL DEFAULT 1,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    models_refreshed_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
  );
  ALTER TABLE agents
    ADD COLUMN credential_id text REFERENCES credentials(id),
    ADD COLUMN model text,
    ADD COLUMN effort text,
    ADD COLUMN instructions text NOT NULL DEFAULT '',
    ADD COLUMN max_turns int NOT NULL DEFAULT 40,
    ADD COLUMN config_revision int NOT NULL DEFAULT 1;
  ALTER TABLE agent_runtimes ADD COLUMN applied_secret_rev text;
  `,
  `
  -- Anthropic keys created at the organization level must name a workspace on every request.
  ALTER TABLE credentials ADD COLUMN workspace_id text;
  `,
  `
  -- OpenAI-compatible providers: the owner's endpoint for provider "custom" (presets resolve theirs in code).
  ALTER TABLE credentials ADD COLUMN base_url text;
  `,
  `
  -- People. The owner is the one row with is_owner; everyone else holds only the
  -- grants stored under principal "user:<id>" (no FK: principals are agents or people).
  CREATE TABLE users (
    id text PRIMARY KEY,
    display_name text NOT NULL,
    role_id text,                            -- preset the permissions were copied from (informational)
    is_owner boolean NOT NULL DEFAULT false,
    disabled_at timestamptz,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX users_one_owner ON users(is_owner) WHERE is_owner;
  INSERT INTO users(id, display_name, is_owner, created_by) VALUES ('owner', 'Owner', true, 'system:migration');
  ALTER TABLE grants DROP CONSTRAINT grants_principal_id_fkey;
  `,
  `
  -- Many organizations per install. Each org carries its own structure document
  -- (departments, projects, agent templates, policy profiles, role presets) in
  -- config, edited in the UI; rows of every org-owned table name their org.
  ALTER TABLE organizations
    ADD COLUMN config jsonb,
    ADD COLUMN config_revision int NOT NULL DEFAULT 1,
    ADD COLUMN template_id text,
    ADD COLUMN created_by text,
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN archived_at timestamptz,
    ADD COLUMN runtime_namespace text UNIQUE;

  ALTER TABLE agents ADD COLUMN org_id text REFERENCES organizations(id);
  ALTER TABLE tasks ADD COLUMN org_id text REFERENCES organizations(id);
  ALTER TABLE credentials ADD COLUMN org_id text REFERENCES organizations(id);
  ALTER TABLE grants ADD COLUMN org_id text REFERENCES organizations(id);
  ALTER TABLE agent_events ADD COLUMN org_id text REFERENCES organizations(id);
  ALTER TABLE terminal_sessions ADD COLUMN org_id text REFERENCES organizations(id);
  ALTER TABLE audit_events ADD COLUMN org_id text REFERENCES organizations(id); -- NULL: instance-level
  UPDATE agents SET org_id = (SELECT id FROM organizations ORDER BY id LIMIT 1);
  UPDATE tasks SET org_id = (SELECT id FROM organizations ORDER BY id LIMIT 1);
  UPDATE credentials SET org_id = (SELECT id FROM organizations ORDER BY id LIMIT 1);
  UPDATE grants SET org_id = (SELECT id FROM organizations ORDER BY id LIMIT 1);
  UPDATE agent_events SET org_id = (SELECT id FROM organizations ORDER BY id LIMIT 1);
  UPDATE terminal_sessions SET org_id = (SELECT id FROM organizations ORDER BY id LIMIT 1);
  UPDATE audit_events SET org_id = (SELECT id FROM organizations ORDER BY id LIMIT 1);
  ALTER TABLE agents ALTER COLUMN org_id SET NOT NULL;
  ALTER TABLE tasks ALTER COLUMN org_id SET NOT NULL;
  ALTER TABLE credentials ALTER COLUMN org_id SET NOT NULL;
  ALTER TABLE grants ALTER COLUMN org_id SET NOT NULL;
  ALTER TABLE agent_events ALTER COLUMN org_id SET NOT NULL;
  ALTER TABLE terminal_sessions ALTER COLUMN org_id SET NOT NULL;
  CREATE INDEX agents_org ON agents(org_id);
  CREATE INDEX grants_org ON grants(org_id);
  CREATE INDEX tasks_org ON tasks(org_id, status);
  CREATE INDEX agent_events_org ON agent_events(org_id, seq);
  CREATE INDEX audit_events_org ON audit_events(org_id, id);

  -- Idempotency keys are per organization.
  ALTER TABLE agents DROP CONSTRAINT agents_spawn_key_key;
  ALTER TABLE agents ADD CONSTRAINT agents_org_spawn_key UNIQUE (org_id, spawn_key);
  ALTER TABLE tasks DROP CONSTRAINT tasks_idempotency_key_key;
  ALTER TABLE tasks ADD CONSTRAINT tasks_org_idempotency_key UNIQUE (org_id, idempotency_key);

  -- Departments and projects live in the org's config document now.
  ALTER TABLE agents DROP CONSTRAINT agents_department_id_fkey;
  ALTER TABLE tasks DROP CONSTRAINT tasks_project_id_fkey;
  DROP TABLE departments;
  DROP TABLE projects;

  -- People are accounts on the install; what they may do is per organization.
  CREATE TABLE org_members (
    org_id text NOT NULL REFERENCES organizations(id),
    user_id text NOT NULL REFERENCES users(id),
    is_owner boolean NOT NULL DEFAULT false,
    role_id text,                            -- preset the permissions were copied from (informational)
    disabled_at timestamptz,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id)
  );
  CREATE UNIQUE INDEX org_members_one_owner ON org_members(org_id) WHERE is_owner;
  INSERT INTO org_members(org_id, user_id, is_owner, role_id, disabled_at, created_by, created_at)
    SELECT o.id, u.id, u.is_owner, u.role_id, u.disabled_at, u.created_by, u.created_at FROM users u CROSS JOIN organizations o;
  -- The single owner of the old install becomes the instance admin.
  UPDATE users SET disabled_at = NULL;
  ALTER TABLE users RENAME COLUMN is_owner TO is_admin;
  ALTER TABLE users DROP COLUMN role_id;
  ALTER INDEX users_one_owner RENAME TO users_one_admin;
  `,
  `
  -- Organization templates people saved or imported (built-ins ship as files).
  -- Visible to their author and the instance admin only.
  CREATE TABLE templates (
    id text PRIMARY KEY,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    doc jsonb NOT NULL,
    owner_user_id text NOT NULL REFERENCES users(id),
    source_org_id text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  `,
  `
  -- Art for the office: binary glTF models and textures, per organization.
  CREATE TABLE assets (
    id text PRIMARY KEY,
    org_id text NOT NULL REFERENCES organizations(id),
    kind text NOT NULL,                      -- model | texture
    name text NOT NULL,
    content_type text NOT NULL,              -- decided from the bytes, never the client
    size int NOT NULL,
    sha256 text NOT NULL,
    content bytea NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, sha256)
  );
  `,
  `
  -- Queue legacy runtimes; the server applies these only with an approved
  -- target preset and no running task. New script runtimes are not queued.
  ALTER TABLE agent_runtimes ADD COLUMN pending_preset_id text;
  UPDATE agent_runtimes SET pending_preset_id='claude-v1' WHERE preset_id='script-v1';
  CREATE TABLE data_migrations (
    name text PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now()
  );
  `,
  `
  -- Private owner conversations. Model context is independent of the visible transcript.
  CREATE TABLE owner_chats (
    id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id),
    user_id text NOT NULL REFERENCES users(id), title text NOT NULL DEFAULT 'New chat',
    config jsonb NOT NULL, context jsonb NOT NULL DEFAULT '[]',
    context_tokens int NOT NULL DEFAULT 0, count_mode text NOT NULL DEFAULT 'estimated',
    model_info jsonb, usage jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX owner_chats_scope ON owner_chats(org_id,user_id,updated_at DESC);
  CREATE TABLE owner_chat_runs (
    id text PRIMARY KEY, chat_id text NOT NULL REFERENCES owner_chats(id) ON DELETE CASCADE,
    request_id text NOT NULL, status text NOT NULL, kind text NOT NULL DEFAULT 'message',
    rounds int NOT NULL DEFAULT 0, partial_text text NOT NULL DEFAULT '', error text,
    created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
    UNIQUE(chat_id,request_id)
  );
  CREATE UNIQUE INDEX owner_chat_active ON owner_chat_runs(chat_id) WHERE status IN ('running','waiting_approval');
  CREATE TABLE owner_chat_messages (
    id bigserial PRIMARY KEY, chat_id text NOT NULL REFERENCES owner_chats(id) ON DELETE CASCADE,
    run_id text REFERENCES owner_chat_runs(id), role text NOT NULL, text text NOT NULL,
    partial boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX owner_chat_history ON owner_chat_messages(chat_id,id);
  CREATE TABLE owner_chat_actions (
    id text PRIMARY KEY, run_id text NOT NULL REFERENCES owner_chat_runs(id) ON DELETE CASCADE,
    tool_id text NOT NULL, name text NOT NULL, args jsonb NOT NULL, status text NOT NULL,
    result jsonb, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,tool_id)
  );
  `,
  `ALTER TABLE owner_chats ADD COLUMN archived_at timestamptz;`,
  `ALTER TABLE credentials ADD COLUMN api_protocol text CHECK (api_protocol IN ('anthropic','openai'));
   ALTER TABLE credentials ADD COLUMN auth_header jsonb;`,
  `UPDATE credentials SET key_hint=CASE WHEN key_hint<>'' THEN 'stored' ELSE '' END;`,
  `ALTER TABLE owner_chats ADD COLUMN subject_type text NOT NULL DEFAULT 'owner' CHECK (subject_type IN ('owner','agent','object'));
   ALTER TABLE owner_chats ADD COLUMN subject_id text NOT NULL DEFAULT '';
   ALTER TABLE owner_chats ADD CONSTRAINT owner_chat_subject CHECK ((subject_type='owner')=(subject_id=''));
   CREATE INDEX owner_chats_subject ON owner_chats(org_id,user_id,subject_type,subject_id,updated_at DESC);
   UPDATE organizations o SET config=jsonb_set(config,'{world,objects}',
     (SELECT jsonb_agg(CASE WHEN item ? 'id' THEN item ELSE item || jsonb_build_object('id','obj-' || substr(md5(o.id || ':' || n::text),1,16)) END ORDER BY n)
      FROM jsonb_array_elements(config->'world'->'objects') WITH ORDINALITY AS a(item,n))), config_revision=config_revision+1
   WHERE jsonb_typeof(config->'world'->'objects')='array' AND EXISTS
     (SELECT 1 FROM jsonb_array_elements(config->'world'->'objects') AS a(item) WHERE NOT item ? 'id');`,
  `ALTER TABLE tasks ALTER COLUMN max_attempts SET DEFAULT 5;
   -- 20 was the original chat default; preserve other explicit limits and all token/model settings.
   UPDATE owner_chats SET config=jsonb_set(config,'{maxTurns}','5'::jsonb)
   WHERE config->>'maxTurns'='20';`,
  `CREATE INDEX IF NOT EXISTS agent_events_task ON agent_events(org_id,task_id,seq);
   CREATE INDEX IF NOT EXISTS agent_events_work ON agent_events(org_id,agent_id,at) WHERE type='work.state';
   CREATE INDEX IF NOT EXISTS task_runs_task ON task_runs(task_id,started_at DESC,id DESC);
   CREATE INDEX IF NOT EXISTS agent_logs_run ON agent_logs(agent_id,run_id,seq);`,
  `ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS config_snapshot jsonb;
   ALTER TABLE agents ADD COLUMN IF NOT EXISTS context_limit int CHECK (context_limit IS NULL OR context_limit BETWEEN 8192 AND 1000000);
   CREATE INDEX IF NOT EXISTS agent_events_config ON agent_events(org_id,(payload->>'by'),at) WHERE type='agent.configured';`,
  // Teams: one shared runtime per team; members declare the share they add to it.
  `ALTER TABLE agents ADD COLUMN IF NOT EXISTS team_id text;
   ALTER TABLE agents ADD COLUMN IF NOT EXISTS cpu_millis int CHECK (cpu_millis IS NULL OR cpu_millis BETWEEN 10 AND 64000);
   ALTER TABLE agents ADD COLUMN IF NOT EXISTS memory_mib int CHECK (memory_mib IS NULL OR memory_mib BETWEEN 32 AND 262144);
   ALTER TABLE agent_runtimes ADD COLUMN IF NOT EXISTS legacy_pod boolean NOT NULL DEFAULT true;
   CREATE TABLE IF NOT EXISTS team_runtimes (
     org_id text NOT NULL REFERENCES organizations(id),
     team_id text NOT NULL,
     runtime_id text NOT NULL,
     preset_id text NOT NULL,
     generation int NOT NULL DEFAULT 1,
     namespace text NOT NULL,
     storage_ref text NOT NULL,
     workload_ref text,
     observed_state text NOT NULL DEFAULT 'none',
     observed_detail text,
     observed_at timestamptz,
     ready_generation int,
     applied_resources jsonb,
     PRIMARY KEY (org_id, team_id)
   );
   CREATE TABLE IF NOT EXISTS team_messages (
     id bigserial PRIMARY KEY,
     org_id text NOT NULL REFERENCES organizations(id),
     team_id text NOT NULL,
     author_kind text NOT NULL CHECK (author_kind IN ('human','agent')),
     author_id text NOT NULL,
     text text NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
     at timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX IF NOT EXISTS team_messages_team ON team_messages(org_id, team_id, id);`,
  // Proposal & Approval Engine: one record per proposed change, whatever proposed it.
  `CREATE TABLE IF NOT EXISTS proposals (
     id text PRIMARY KEY,
     org_id text NOT NULL REFERENCES organizations(id),
     kind text NOT NULL CHECK (kind IN ('capability_call','config_change','task_result','world_change','permission_change','runtime_change','team_change')),
     title text NOT NULL,
     proposer text NOT NULL,
     subject_type text,
     subject_id text,
     payload jsonb NOT NULL DEFAULT '{}',
     source_type text NOT NULL,
     source_id text NOT NULL,
     status text NOT NULL CHECK (status IN ('pending','approved','rejected','applying','applied','failed','expired','withdrawn')),
     evaluation jsonb NOT NULL DEFAULT '[]',
     approvers jsonb NOT NULL DEFAULT '{"kind":"owner"}',
     decisions jsonb NOT NULL DEFAULT '[]',
     receipt jsonb,
     error text,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (source_type, source_id)
   );
   CREATE INDEX IF NOT EXISTS proposals_org ON proposals(org_id, status, created_at DESC);
   INSERT INTO proposals(id, org_id, kind, title, proposer, subject_type, subject_id, payload, source_type, source_id, status, approvers)
   SELECT 'p-' || substr(md5(t.id || ':' || t.attempt), 1, 12), t.org_id, 'task_result', 'Review: ' || t.title,
          COALESCE('agent:' || t.assignee_agent_id, 'system'), 'task', t.id,
          jsonb_build_object('taskId', t.id, 'attempt', t.attempt, 'summary', t.summary),
          'task', t.id || ':' || t.attempt, 'pending', jsonb_build_object('kind', 'task_reviewer', 'createdBy', t.created_by)
     FROM tasks t WHERE t.status = 'review'
   ON CONFLICT (source_type, source_id) DO NOTHING;`,
  // 20: template language — what agents write in and which names the template's world shows.
  `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en' CHECK (language IN ('en','vi'));`,
  // 21: what a template's world is called as a whole ("café"), kept by the organizations made from it.
  `ALTER TABLE templates ADD COLUMN IF NOT EXISTS term text;
   ALTER TABLE organizations ADD COLUMN IF NOT EXISTS term text;`,
  // 22: who said each chat line, which chats mention whom, tasks a chat handed off, what objects are doing.
  `ALTER TABLE owner_chat_messages ADD COLUMN IF NOT EXISTS author_type text CHECK (author_type IN ('agent','object'));
   ALTER TABLE owner_chat_messages ADD COLUMN IF NOT EXISTS author_id text;
   CREATE TABLE IF NOT EXISTS chat_refs (
     chat_id text NOT NULL REFERENCES owner_chats(id) ON DELETE CASCADE,
     subject_type text NOT NULL CHECK (subject_type IN ('agent','object')),
     subject_id text NOT NULL,
     at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (chat_id, subject_type, subject_id)
   );
   CREATE INDEX IF NOT EXISTS chat_refs_subject ON chat_refs(subject_type, subject_id, at DESC);
   CREATE TABLE IF NOT EXISTS chat_tasks (
     chat_id text NOT NULL REFERENCES owner_chats(id) ON DELETE CASCADE,
     task_id text NOT NULL,
     reported_status text,
     PRIMARY KEY (chat_id, task_id)
   );
   CREATE TABLE IF NOT EXISTS object_states (
     org_id text NOT NULL REFERENCES organizations(id),
     object_id text NOT NULL,
     action text NOT NULL,
     state text NOT NULL,
     by_type text NOT NULL CHECK (by_type IN ('human','agent','object')),
     by_id text NOT NULL,
     until timestamptz NOT NULL,
     at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (org_id, object_id)
   );`,
  // 23: campaigns, goals inside a project that agents work toward step by step (auto) or people fill with tasks (manual).
  `CREATE TABLE IF NOT EXISTS campaigns (
     id text PRIMARY KEY,
     org_id text NOT NULL REFERENCES organizations(id),
     project_id text NOT NULL,
     title text NOT NULL,
     goal text NOT NULL,
     mode text NOT NULL CHECK (mode IN ('auto','manual')),
     status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','failed','stopped')),
     lead_agent_id text REFERENCES agents(id),
     max_failures int NOT NULL DEFAULT 3,
     max_steps int NOT NULL DEFAULT 12,
     failure_base int NOT NULL DEFAULT 0,
     step_base int NOT NULL DEFAULT 0,
     summary text,
     created_by text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX IF NOT EXISTS campaigns_org ON campaigns(org_id, project_id);
   ALTER TABLE tasks ADD COLUMN IF NOT EXISTS campaign_id text REFERENCES campaigns(id);
   ALTER TABLE tasks ADD COLUMN IF NOT EXISTS campaign_step int;
   CREATE INDEX IF NOT EXISTS tasks_campaign ON tasks(campaign_id);`,
  // 24: agents ask the person who gave them the work (a question with a deadline, then they decide themselves).
  `ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_kind_check;
   ALTER TABLE proposals ADD CONSTRAINT proposals_kind_check
     CHECK (kind IN ('capability_call','config_change','task_result','world_change','permission_change','runtime_change','team_change','question'));
   CREATE INDEX IF NOT EXISTS proposals_task ON proposals ((payload->>'taskId')) WHERE status = 'pending';`,
  // 25: credentials of the world's connectors (MCP servers): one header each, sealed by the SecretBox.
  `CREATE TABLE IF NOT EXISTS connector_credentials (
     org_id text NOT NULL REFERENCES organizations(id),
     connector_id text NOT NULL,
     header text NOT NULL,
     ciphertext bytea NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (org_id, connector_id)
   );`,
];

/** Bring the schema up to date (or only up to version `upTo`, for upgrade tests). */
export async function migrate(db: Db, upTo = MIGRATIONS.length): Promise<void> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())");
  // The server and the cluster provisioner may both migrate: serialize them.
  await tx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(7340211)");
    const { rows } = await c.query<{ v: number | null }>("SELECT max(version) AS v FROM schema_migrations");
    for (let i = rows[0]?.v ?? 0; i < upTo; i++) {
      await c.query(MIGRATIONS[i]!);
      await c.query("INSERT INTO schema_migrations(version) VALUES ($1)", [i + 1]);
    }
  });
}
