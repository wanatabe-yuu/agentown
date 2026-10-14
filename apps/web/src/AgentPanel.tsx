import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { api } from "./api.ts";
import { AgentConfigForm } from "./Credentials.tsx";
import type { Agent, AgentDetail, Catalog, Credential, Snapshot, WorkState } from "./types.ts";
import { ago, describeScope, StatusPill } from "./ui.tsx";

// xterm is only loaded when someone actually opens a terminal.
const Terminal = lazy(() => import("./Terminal.tsx").then((m) => ({ default: m.Terminal })));

type Tab = "overview" | "tasks" | "logs" | "config" | "permissions" | "terminal";

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
  // Only what this person may do is shown; the server re-checks every request anyway.
  const visibleTabs = (["overview", "tasks", "logs", "config", "permissions", "terminal"] as Tab[]).filter(
    (t) => (t !== "logs" || can["runtime.logs"]) && (t !== "config" || can["agent.configure"]) && (t !== "terminal" || can["runtime.exec"]),
  );
  const shownTab = visibleTabs.includes(tab) ? tab : "overview";

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
        {visibleTabs.map((t) => (
          <button key={t} role="tab" aria-selected={shownTab === t} className={shownTab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>

      <div className="panel-body">
        {shownTab === "overview" && (
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
              <div>Model</div>
              <div>
                {agent.config.model ?? <span className="muted">template default</span>}
                {detail?.credential && <span className="muted small"> · key {detail.credential.name} ({detail.credential.keyHint})</span>}
              </div>
              <div>Reports to</div>
              <div>{manager ? `${manager.displayName} (${manager.jobRole})` : "— (top of org)"}</div>
              <div>Direct reports</div>
              <div>{reports.length ? reports.map((r) => r.displayName).join(", ") : "none"}</div>
            </section>

            {(can["task.create"] || can["runtime.control"]) && (
              <section className="actions">
                <h3>Actions</h3>
                <div className="btn-row">
                  {can["task.create"] && (
                    <button type="button" onClick={() => p.onNewTask(agent.id)}>
                      Assign task
                    </button>
                  )}
                  {can["runtime.control"] && (
                    <>
                      {agent.acceptingWork ? (
                        <button type="button" onClick={() => act("Pause intake", "POST", `/api/agents/${agent.id}/pause`)}>
                          Pause intake
                        </button>
                      ) : (
                        <button type="button" onClick={() => act("Resume intake", "POST", `/api/agents/${agent.id}/resume`)}>
                          Resume intake
                        </button>
                      )}
                      {agent.desiredRuntime === "running" ? (
                        <button type="button" onClick={() => act("Stop runtime", "POST", `/api/agents/${agent.id}/runtime/stop`)}>
                          Stop runtime
                        </button>
                      ) : (
                        <button type="button" onClick={() => act("Start runtime", "POST", `/api/agents/${agent.id}/runtime/start`)}>
                          Start runtime
                        </button>
                      )}
                      <button type="button" onClick={() => act("Replace runtime", "POST", `/api/agents/${agent.id}/runtime/restart`)}>
                        Replace runtime
                      </button>
                    </>
                  )}
                </div>
              </section>
            )}

            {detail?.id === agent.id && detail.spawnTemplates.length > 0 && p.catalog && (
              <SpawnForm manager={agent} catalog={p.catalog} templates={detail.spawnTemplates} notify={p.notify} />
            )}
          </>
        )}

        {shownTab === "tasks" && <AgentTasks agent={agent} snapshot={p.snapshot} onOpenTask={p.onOpenTask} />}
        {shownTab === "logs" && <Logs agentId={agent.id} />}
        {shownTab === "config" && detail && detail.id === agent.id && (
          <AgentConfigForm
            key={`${detail.id}:${detail.config.credentialId}:${detail.config.model}`}
            detail={detail}
            departmentId={agent.departmentId}
            harness={p.catalog?.presets.find((x) => x.id === agent.runtime?.presetId)?.harness}
            notify={p.notify}
          />
        )}
        {shownTab === "permissions" && detail && (
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
        {shownTab === "terminal" && (
          <Suspense fallback={<p className="muted">Loading terminal…</p>}>
            <Terminal agentId={agent.id} />
          </Suspense>
        )}
      </div>
    </aside>
  );
}

function SpawnForm({ manager, catalog: full, templates: allowed, notify }: { manager: Agent; catalog: Catalog; templates: string[]; notify: Props["notify"] }) {
  const catalog = { ...full, templates: full.templates.filter((t) => allowed.includes(t.id)) };
  const [template, setTemplate] = useState(catalog.templates.find((t) => t.jobRole === "engineer")?.id ?? catalog.templates[0]!.id);
  const [name, setName] = useState("");
  const [creds, setCreds] = useState<Credential[]>([]);
  const [credentialId, setCredentialId] = useState("");
  const [model, setModel] = useState("");
  const tpl = catalog.templates.find((t) => t.id === template);
  const usesModel = catalog.presets.find((p) => p.id === tpl?.runtimePreset)?.harness !== "script";
  useEffect(() => {
    if (!usesModel) return;
    api<{ credentials: Credential[] }>("GET", "/api/credentials")
      .then((r) => setCreds(r.credentials.filter((c) => !c.revokedAt && (!c.departments || c.departments.includes(manager.departmentId)))))
      .catch(() => setCreds([]));
  }, [usesModel, manager.departmentId]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api("POST", "/api/agents", {
        templateId: template,
        displayName: name || "New hire",
        reportsToAgentId: manager.id,
        idempotencyKey: `ui-${crypto.randomUUID()}`,
        ...(usesModel && credentialId ? { config: { credentialId, model: model || null } } : {}),
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
      {usesModel && (
        <div className="form-row">
          <select value={credentialId} onChange={(e) => { setCredentialId(e.target.value); setModel(""); }} aria-label="API key">
            <option value="">API key: none yet</option>
            {creds.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.keyHint})
              </option>
            ))}
          </select>
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!credentialId} aria-label="Model">
            <option value="">model: template default</option>
            {(creds.find((c) => c.id === credentialId)?.models ?? []).map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </div>
      )}
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

function Logs({ agentId }: { agentId: string }) {
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
  if (error && !lines.length) return <p className="error">{error}</p>;
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
