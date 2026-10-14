import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { api } from "./api.ts";
import type { Agent, AgentDetail, Catalog, Snapshot, WorkState } from "./types.ts";
import { ago, describeScope, StatusPill } from "./ui.tsx";

// xterm is only loaded when someone actually opens a terminal.
const Terminal = lazy(() => import("./Terminal.tsx").then((m) => ({ default: m.Terminal })));

type Tab = "overview" | "tasks" | "logs" | "permissions" | "terminal";

interface Props {
  agentId: string;
  snapshot: Snapshot;
  catalog: Catalog | null;
  workOf: (a: Agent) => WorkState;
  now: number;
  onClose: () => void;
  onOpenTask: (id: string) => void;
  onNewTask: (assignee: string) => void;
  notify: (msg: string, kind?: "error" | "info") => void;
}

export function AgentPanel(p: Props) {
  const agent = p.snapshot.agents.find((a) => a.id === p.agentId);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => setTab("overview"), [p.agentId]);
  useEffect(() => {
    let live = true;
    api<AgentDetail>("GET", `/api/agents/${p.agentId}`)
      .then((d) => live && setDetail(d))
      .catch((e) => p.notify(e.message, "error"));
    return () => {
      live = false;
    };
    // Re-read permissions when the org changes (cursor moves on structural events).
  }, [p.agentId, p.snapshot.agents]);

  if (!agent) return null;
  const work = p.workOf(agent);
  const manager = p.snapshot.agents.find((a) => a.id === agent.reportsToAgentId);
  const reports = p.snapshot.agents.filter((a) => a.reportsToAgentId === agent.id && a.lifecycleState !== "retired");
  const dept = p.snapshot.departments.find((d) => d.id === agent.departmentId);
  const can = detail?.id === agent.id ? detail.can : {};

  const act = async (label: string, method: string, path: string, body?: unknown) => {
    try {
      await api(method, path, body);
      p.notify(`${label}: requested`, "info");
    } catch (e) {
      p.notify(`${label}: ${(e as Error).message}`, "error");
    }
  };

  return (
    <aside className="panel" aria-label={`${agent.displayName} details`}>
      <header className="panel-head">
        <div className="avatar" style={{ background: dept?.color }} aria-hidden>
          {agent.displayName.slice(0, 1)}
        </div>
        <div className="panel-title">
          <h2>{agent.displayName}</h2>
          <div className="muted">
            {agent.jobRole} · {dept?.name} · <code>{agent.id}</code>
          </div>
        </div>
        <button type="button" className="icon-btn" onClick={p.onClose} aria-label="Close panel">
          ×
        </button>
      </header>

      <nav className="tabs" role="tablist">
        {(["overview", "tasks", "logs", "permissions", "terminal"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)} disabled={t === "terminal" && !can["runtime.exec"]} title={t === "terminal" && !can["runtime.exec"] ? "You do not hold runtime.exec on this agent" : undefined}>
            {t}
          </button>
        ))}
      </nav>

      <div className="panel-body">
        {tab === "overview" && (
          <>
            <section className="kv">
              <div>Work</div>
              <div>
                <StatusPill state={work} /> {agent.work.detail && <span className="muted">{agent.work.detail}</span>}
                <div className="muted small">reported {ago(agent.work.updatedAt, p.now)} · heartbeat {ago(agent.lastHeartbeatAt, p.now)}</div>
              </div>
              <div>Runtime</div>
              <div>
                <StatusPill state={agent.runtime?.state ?? "none"} /> <span className="muted">g{agent.runtime?.generation} · {agent.runtime?.presetId}</span>
                {agent.runtime?.detail && <div className="muted small">{agent.runtime.detail}</div>}
                <div className="muted small">
                  {agent.runtime?.workloadRef ?? "no workload"} · observed {ago(agent.runtime?.observedAt ?? null, p.now)}
                </div>
              </div>
              <div>Lifecycle</div>
              <div>
                {agent.lifecycleState} · intake {agent.acceptingWork ? "open" : "paused"} · desired {agent.desiredRuntime}
              </div>
              <div>Reports to</div>
              <div>{manager ? `${manager.displayName} (${manager.jobRole})` : "— (top of org)"}</div>
              <div>Direct reports</div>
              <div>{reports.length ? reports.map((r) => r.displayName).join(", ") : "none"}</div>
            </section>

            <section className="actions">
              <h3>Actions</h3>
              <p className="muted small">Buttons follow your grants; the server re-checks every request.</p>
              <div className="btn-row">
                <button type="button" disabled={!can["task.create"]} onClick={() => p.onNewTask(agent.id)}>
                  Assign task
                </button>
                {agent.acceptingWork ? (
                  <button type="button" disabled={!can["runtime.control"]} onClick={() => act("Pause intake", "POST", `/api/agents/${agent.id}/pause`)}>
                    Pause intake
                  </button>
                ) : (
                  <button type="button" disabled={!can["runtime.control"]} onClick={() => act("Resume intake", "POST", `/api/agents/${agent.id}/resume`)}>
                    Resume intake
                  </button>
                )}
                {agent.desiredRuntime === "running" ? (
                  <button type="button" disabled={!can["runtime.control"]} onClick={() => act("Stop runtime", "POST", `/api/agents/${agent.id}/runtime/stop`)}>
                    Stop runtime
                  </button>
                ) : (
                  <button type="button" disabled={!can["runtime.control"]} onClick={() => act("Start runtime", "POST", `/api/agents/${agent.id}/runtime/start`)}>
                    Start runtime
                  </button>
                )}
                <button type="button" disabled={!can["runtime.control"]} onClick={() => act("Replace runtime", "POST", `/api/agents/${agent.id}/runtime/restart`)}>
                  Replace runtime
                </button>
              </div>
            </section>

            {can["agent.spawn"] && p.catalog && <SpawnForm manager={agent} catalog={p.catalog} notify={p.notify} />}
          </>
        )}

        {tab === "tasks" && <AgentTasks agent={agent} snapshot={p.snapshot} onOpenTask={p.onOpenTask} />}
        {tab === "logs" && <Logs agentId={agent.id} allowed={!!can["runtime.logs"]} />}
        {tab === "permissions" && detail && (
          <section>
            <p className="muted small">
              Effective rights come only from these grants, evaluated against the current reporting line. The job title grants nothing.
            </p>
            <table className="grid">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Scope</th>
                  <th>Issuer</th>
                </tr>
              </thead>
              <tbody>
                {detail.grants.map((g) => (
                  <tr key={g.id}>
                    <td>
                      <code>{g.action}</code>
                      {g.delegable && <span className="tag">delegable</span>}
                    </td>
                    <td>
                      {describeScope(g.scope)}
                      {g.constraints.templates && <div className="muted small">templates: {g.constraints.templates.join(", ")}</div>}
                    </td>
                    <td className="muted small">{g.issuer}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        {tab === "terminal" && can["runtime.exec"] && (
          <Suspense fallback={<p className="muted">Loading terminal…</p>}>
            <Terminal agentId={agent.id} />
          </Suspense>
        )}
      </div>
    </aside>
  );
}

function SpawnForm({ manager, catalog, notify }: { manager: Agent; catalog: Catalog; notify: Props["notify"] }) {
  const [template, setTemplate] = useState(catalog.templates.find((t) => t.jobRole === "engineer")?.id ?? catalog.templates[0]!.id);
  const [name, setName] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api("POST", "/api/agents", {
        templateId: template,
        displayName: name || "New hire",
        reportsToAgentId: manager.id,
        idempotencyKey: `ui-${crypto.randomUUID()}`,
      });
      notify(`Hiring ${r.agent.displayName} (${r.agent.id}); runtime is provisioning`, "info");
      setName("");
    } catch (err) {
      notify(`Spawn: ${(err as Error).message}`, "error");
    }
  };
  return (
    <form className="actions" onSubmit={submit}>
      <h3>Hire under {manager.displayName}</h3>
      <p className="muted small">Only approved templates; the server checks your agent.spawn grant for this manager and template.</p>
      <div className="form-row">
        <select value={template} onChange={(e) => setTemplate(e.target.value)} aria-label="Template">
          {catalog.templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.id} ({t.jobRole}, {t.runtimePreset})
            </option>
          ))}
        </select>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" maxLength={40} aria-label="Display name" />
        <button type="submit">Spawn</button>
      </div>
    </form>
  );
}

function AgentTasks({ agent, snapshot, onOpenTask }: { agent: Agent; snapshot: Snapshot; onOpenTask: (id: string) => void }) {
  const tasks = useMemo(() => snapshot.tasks.filter((t) => t.assigneeAgentId === agent.id), [snapshot.tasks, agent.id]);
  if (!tasks.length) return <p className="muted">No tasks assigned.</p>;
  return (
    <ul className="task-list">
      {tasks.map((t) => (
        <li key={t.id}>
          <button type="button" className="task-row" onClick={() => onOpenTask(t.id)}>
            <StatusPill state={t.status} />
            <span className="task-title">{t.title}</span>
            <span className="muted small">{t.summary ?? t.statusReason ?? ""}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Logs({ agentId, allowed }: { agentId: string; allowed: boolean }) {
  const [lines, setLines] = useState<Array<{ seq: number; stream: string; line: string; at: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLines([]);
    setError(null);
    let after = 0;
    let live = true;
    const pull = async () => {
      try {
        const r = await api<{ lines: typeof lines }>("GET", `/api/agents/${agentId}/logs?after=${after}`);
        if (!live) return;
        if (r.lines.length) {
          after = r.lines[r.lines.length - 1]!.seq;
          setLines((l) => [...l, ...r.lines].slice(-1000));
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void pull();
    const id = setInterval(pull, 2000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [agentId]);
  if (!allowed && error) return <p className="error">{error}</p>;
  return (
    <pre className="logs" aria-live="polite">
      {lines.length === 0 && <span className="muted">No work logs yet.</span>}
      {lines.map((l) => (
        <div key={l.seq} className={`log-${l.stream}`}>
          <span className="muted">{new Date(l.at).toLocaleTimeString()} </span>
          {l.line}
        </div>
      ))}
    </pre>
  );
}
