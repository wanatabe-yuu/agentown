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
];

export async function migrate(db: Db): Promise<void> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())");
  const { rows } = await db.query<{ v: number | null }>("SELECT max(version) AS v FROM schema_migrations");
  const current = rows[0]?.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    await tx(db, async (c) => {
      await c.query(MIGRATIONS[i]!);
      await c.query("INSERT INTO schema_migrations(version) VALUES ($1)", [i + 1]);
    });
  }
}
