import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { t as tr } from "./i18n.ts";
import { api } from "./api.ts";
import { requestId } from "./requestId.ts";
import { AgentConfigForm } from "./Credentials.tsx";
import { ReportText } from "./Markdown.tsx";
import { t } from "./i18n.ts";
import type { Agent, AgentDetail, Catalog, Credential, Snapshot, Team, WorkState } from "./types.ts";
import { ago, describeScope, StatusPill } from "./ui.tsx";

// xterm is only loaded when someone actually opens a terminal.
const Terminal = lazy(() => import("./Terminal.tsx").then((m) => ({ default: m.Terminal })));
// three.js comes with the office; the studio waits for it rather than weighing down the panel.
const AgentStudio = lazy(() => import("./office3d/AgentStudio.tsx"));

type Tab = "overview" | "tasks" | "logs" | "config" | "permissions" | "terminal";
const TAB_LABEL: Record<Tab, string> = { overview: "Overview", tasks: "Tasks", logs: "Logs", config: "Config", permissions: "Permissions", terminal: "Terminal" };

interface Props {
  agentId: string;
  snapshot: Snapshot;
  catalog: Catalog | null;
  workOf: (a: Agent) => WorkState;
  now: number;
  onChat?: () => void;
  onClose: () => void;
  onOpenTask: (id: string) => void;
  onNewTask: (assignee: string) => void;
  notify: (msg: string, kind?: "error" | "info") => void;
  /** May change how this agent looks (org.design). */
  canDesign?: boolean;
}

const cpuText = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(m % 1000 ? 1 : 0)} CPU` : `${m}m`);
const memText = (mi: number) => (mi >= 1024 ? `${(mi / 1024).toFixed(mi % 1024 ? 1 : 0)} GiB` : `${mi} MiB`);

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
  const team = p.snapshot.teams.find((x) => x.id === agent.teamId);
  const can = detail?.id === agent.id ? detail.can : {};
  // Only what this person may do is shown; the server re-checks every request anyway.
  const visibleTabs = (["overview", "tasks", "logs", "config", "permissions", "terminal"] as Tab[]).filter(
    (x) => (x !== "logs" || can["runtime.logs"]) && (x !== "config" || can["agent.configure"]) && (x !== "terminal" || can["runtime.exec"]),
  );
  const shownTab = visibleTabs.includes(tab) ? tab : "overview";
  // One plain sentence about anything unusual; the details stay in "Technical details".
  const notes = [
    agent.lifecycleState === "retired" && t("retired"),
    !agent.acceptingWork && t("paused: not taking new work"),
    agent.desiredRuntime === "stopped" && t("runtime stopped"),
  ].filter(Boolean) as string[];

  const act = async (label: string, method: string, path: string, body?: unknown) => {
    try {
      await api(method, path, body);
      p.notify(t("{label}: requested", { label }), "info");
    } catch (e) {
      p.notify(`${label}: ${(e as Error).message}`, "error");
    }
  };

  return (
    <aside className="panel agent-panel" aria-label={agent.displayName}>
      <header className="panel-head">
        <div className="avatar" style={{ background: dept?.color }} aria-hidden>
          {agent.displayName.slice(0, 1)}
        </div>
        <div className="panel-title">
          <h2>{agent.displayName}</h2>
          <div className="muted">
            {agent.jobRole} · {team?.name ?? dept?.name}
          </div>
        </div>
        <button type="button" className="icon-btn" onClick={p.onClose} aria-label={t("Close panel")}>
          ×
        </button>
      </header>

      <div className="tabs-row">
        <nav className="tabs" role="tablist">
          {visibleTabs.map((x) => (
            <button key={x} role="tab" aria-selected={shownTab === x} className={shownTab === x ? "active" : ""} onClick={() => setTab(x)}>
              {t(TAB_LABEL[x])}
            </button>
          ))}
        </nav>
        {p.onChat && (
          <button type="button" className="primary tab-chat" onClick={p.onChat} title={t("Questions, analysis & tasks")} aria-label={t("Chat with {name}", { name: agent.displayName })}>
            {t("Chat")}
          </button>
        )}
      </div>

      <div className="panel-body">
        {shownTab === "overview" && (
          <>
            <Suspense fallback={<div className="studio-stage studio-loading" />}>
              <AgentStudio
                agent={agent}
                world={p.snapshot.world}
                deptColor={dept?.color ?? "#8899aa"}
                work={work}
                activity={[p.snapshot.tasks.find((x) => x.assigneeAgentId === agent.id && x.status === "in_progress")?.title, agent.work.detail].filter(Boolean).join(" · ") || null}
                canDesign={!!p.canDesign}
                notify={p.notify}
                onMore={() => document.getElementById(`agent-facts-${agent.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
              />
            </Suspense>
            <section className="kv" id={`agent-facts-${agent.id}`}>
              <div>{t("Status")}</div>
              <div>
                <StatusPill state={work} /> {agent.work.detail && <span className="muted">{agent.work.detail}</span>}
                <div className="muted small">{t("heartbeat {ago}", { ago: ago(agent.lastHeartbeatAt, p.now) })}</div>
                {notes.length > 0 && <div className="warn-text small">{notes.join(" · ")}</div>}
              </div>
              <div>{t("Team")}</div>
              <div>
                <TeamRow agent={agent} snapshot={p.snapshot} canMove={!!can["agent.update"]} canResize={!!can["runtime.control"]} notify={p.notify} />
              </div>
              <div>{t("Model")}</div>
              <div>
                {agent.config.model ?? <span className="muted">{t("default of its runtime")}</span>}
                <div className="muted small">{detail?.credential ? t("key {name}", { name: detail.credential.name }) : t("no API key")}</div>
              </div>
              <div>{t("Reports to")}</div>
              <div>{manager ? `${manager.displayName} · ${manager.jobRole}` : <span className="muted">{t("top of the organization")}</span>}</div>
              <div>{t("Direct reports")}</div>
              <div>{reports.length ? reports.map((r) => r.displayName).join(", ") : <span className="muted">{t("no one")}</span>}</div>
            </section>

            {(can["task.create"] || can["runtime.control"]) && (
              <section className="actions">
                <h3>{t("Actions")}</h3>
                <div className="btn-row">
                  {can["task.create"] && (
                    <button type="button" className="primary" onClick={() => p.onNewTask(agent.id)}>
                      {t("Assign task")}
                    </button>
                  )}
                  {can["runtime.control"] && (
                    <>
                      {agent.acceptingWork ? (
                        <button type="button" onClick={() => act(t("Pause intake"), "POST", `/api/agents/${agent.id}/pause`)}>
                          {t("Pause intake")}
                        </button>
                      ) : (
                        <button type="button" onClick={() => act(t("Resume intake"), "POST", `/api/agents/${agent.id}/resume`)}>
                          {t("Resume intake")}
                        </button>
                      )}
                      {agent.desiredRuntime === "running" ? (
                        <button type="button" onClick={() => act(t("Stop"), "POST", `/api/agents/${agent.id}/runtime/stop`)}>
                          {t("Stop")}
                        </button>
                      ) : (
                        <button type="button" onClick={() => act(t("Start"), "POST", `/api/agents/${agent.id}/runtime/start`)}>
                          {t("Start")}
                        </button>
                      )}
                      <button type="button" onClick={() => act(t("Restart"), "POST", `/api/agents/${agent.id}/runtime/restart`)}>
                        {t("Restart")}
                      </button>
                    </>
                  )}
                </div>
              </section>
            )}

            {detail?.id === agent.id && detail.spawnTemplates.length > 0 && p.catalog && (
              <SpawnForm manager={agent} catalog={p.catalog} teams={p.snapshot.teams} templates={detail.spawnTemplates} notify={p.notify} />
            )}

            <details className="tech-details">
              <summary>{t("Technical details")}</summary>
              <dl>
                <dt>ID</dt>
                <dd>
                  <code>{agent.id}</code>
                </dd>
                <dt>{tr("Runtime")}</dt>
                <dd>
                  <StatusPill state={agent.runtime?.state ?? "none"} /> g{agent.runtime?.generation} · {agent.runtime?.presetId}
                  {agent.runtime?.detail && <div className="muted small">{agent.runtime.detail}</div>}
                  <div className="muted small">
                    {agent.runtime?.workloadRef ?? "—"} · {ago(agent.runtime?.observedAt ?? null, p.now)}
                  </div>
                </dd>
                <dt>{tr("Lifecycle")}</dt>
                <dd>
                  {agent.lifecycleState} · intake {agent.acceptingWork ? "open" : "paused"} · desired {agent.desiredRuntime}
                </dd>
                <dt>{tr("Template")}</dt>
                <dd>{agent.templateId}</dd>
              </dl>
            </details>
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
            <p className="muted small">{t("Effective rights come only from these grants, evaluated against the current reporting line. The job title grants nothing.")}</p>
            <table className="grid mobile-cards">
              <thead>
                <tr>
                  <th>{t("Action")}</th>
                  <th>{t("Scope")}</th>
                  <th>{t("Issuer")}</th>
                </tr>
              </thead>
              <tbody>
                {detail.grants.map((g) => (
                  <tr key={g.id}>
                    <td>
                      <code>{g.action}</code>
                      {g.delegable && <span className="tag">{tr("delegable")}</span>}
                    </td>
                    <td data-label={t("Scope")}>
                      {describeScope(g.scope)}
                      {g.constraints.templates && <div className="muted small">templates: {g.constraints.templates.join(", ")}</div>}
                    </td>
                    <td data-label={t("Issuer")} className="muted small">
                      {g.issuer}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        {shownTab === "terminal" && (
          <Suspense fallback={<p className="muted">{t("Loading terminal…")}</p>}>
            <Terminal agentId={agent.id} />
          </Suspense>
        )}
      </div>
    </aside>
  );
}

/** The member's team, its shared runtime, and the share of it this member declared. */
function TeamRow({ agent, snapshot, canMove, canResize, notify }: { agent: Agent; snapshot: Snapshot; canMove: boolean; canResize: boolean; notify: Props["notify"] }) {
  const team = snapshot.teams.find((x) => x.id === agent.teamId);
  const [editing, setEditing] = useState(false);
  const [cpu, setCpu] = useState(`${agent.resources.cpu}m`);
  const [memory, setMemory] = useState(`${agent.resources.memory}Mi`);
  const choices = snapshot.teams.filter((x) => x.departmentId === agent.departmentId);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api("PUT", `/api/agents/${agent.id}/resources`, { cpu, memory });
      notify(t("{name}: {cpu} / {memory}; the team runtime resizes when it is idle", { name: agent.displayName, cpu, memory }), "info");
      setEditing(false);
    } catch (err) {
      notify(`${t("CPU")}/${t("Memory")}: ${(err as Error).message}`, "error");
    }
  };
  const move = async (teamId: string) => {
    try {
      await api("PUT", `/api/agents/${agent.id}/team`, { teamId });
      notify(t("{name} moved to {team}", { name: agent.displayName, team: snapshot.teams.find((x) => x.id === teamId)?.name ?? teamId }), "info");
    } catch (err) {
      notify(`${t("Team")}: ${(err as Error).message}`, "error");
    }
  };
  return (
    <>
      <div className="team-line">
        {canMove && choices.length > 1 ? (
          <select value={agent.teamId} onChange={(e) => void move(e.target.value)} aria-label={t("Team")}>
            {choices.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        ) : (
          <b>{team?.name ?? agent.teamId}</b>
        )}
        {team?.runtime && <StatusPill state={team.runtime.state} />}
      </div>
      {team?.runtime?.resources && (
        <div className="muted small">
          {t("Team runtime: {cpu} / {memory} for {n} members", { cpu: cpuText(team.runtime.resources.cpu), memory: memText(team.runtime.resources.memory), n: team.memberIds.length })}
        </div>
      )}
      {team?.runtime?.detail && <div className="muted small">{team.runtime.detail}</div>}
      <div className="muted small">
        {t("Share of the team runtime")}: {t("{cpu} CPU · {memory} memory", { cpu: cpuText(agent.resources.cpu), memory: memText(agent.resources.memory) })}
        {!agent.resources.declared && ` ${t("(default)")}`}
        {canResize && !editing && (
          <>
            {" · "}
            <button type="button" className="link" onClick={() => setEditing(true)}>
              {t("change")}
            </button>
          </>
        )}
      </div>
      {editing && (
        <form className="form-row compact" onSubmit={save}>
          <label>
            {t("CPU")}
            <input value={cpu} onChange={(e) => setCpu(e.target.value)} size={7} placeholder="100m" />
          </label>
          <label>
            {t("Memory")}
            <input value={memory} onChange={(e) => setMemory(e.target.value)} size={7} placeholder="192Mi" />
          </label>
          <button type="submit" className="primary">
            {t("Save")}
          </button>
          <button type="button" onClick={() => setEditing(false)}>
            {t("Cancel")}
          </button>
        </form>
      )}
    </>
  );
}

function SpawnForm({ manager, catalog: full, teams, templates: allowed, notify }: { manager: Agent; catalog: Catalog; teams: Team[]; templates: string[]; notify: Props["notify"] }) {
  const catalog = { ...full, templates: full.templates.filter((x) => allowed.includes(x.id)) };
  const [template, setTemplate] = useState(catalog.templates.find((x) => x.jobRole === "engineer")?.id ?? catalog.templates[0]!.id);
  const [name, setName] = useState("");
  const choices = teams.filter((x) => x.departmentId === manager.departmentId);
  const [teamId, setTeamId] = useState(manager.teamId);
  const tpl = catalog.templates.find((x) => x.id === template);
  const preset = catalog.presets.find((x) => x.id === tpl?.runtimePreset);
  const [cpu, setCpu] = useState(preset?.member?.cpu ?? "100m");
  const [memory, setMemory] = useState(preset?.member?.memory ?? "192Mi");
  const [creds, setCreds] = useState<Credential[]>([]);
  const [credentialId, setCredentialId] = useState("");
  const [model, setModel] = useState("");
  const usesModel = preset?.harness !== "script";
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
        displayName: name || t("New hire"),
        reportsToAgentId: manager.id,
        teamId,
        resources: { cpu, memory },
        idempotencyKey: `ui-${requestId()}`,
        ...(usesModel && credentialId ? { config: { credentialId, model: model || null } } : {}),
      });
      notify(t("Hiring {name}…", { name: r.agent.displayName }), "info");
      setName("");
    } catch (err) {
      notify(`${t("Hire")}: ${(err as Error).message}`, "error");
    }
  };
  return (
    <form className="actions hire" onSubmit={submit}>
      <h3>{t("Hire under {name}", { name: manager.displayName })}</h3>
      <div className="form-grid">
        <label>
          {t("Job")}
          <select value={template} onChange={(e) => setTemplate(e.target.value)}>
            {catalog.templates.map((x) => (
              <option key={x.id} value={x.id}>
                {x.jobRole}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Name")}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("New hire")} maxLength={40} />
        </label>
        <label>
          {t("Team")}
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            {choices.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <div className="form-pair">
          <label>
            {t("CPU")}
            <input value={cpu} onChange={(e) => setCpu(e.target.value)} required placeholder="100m" />
          </label>
          <label>
            {t("Memory")}
            <input value={memory} onChange={(e) => setMemory(e.target.value)} required placeholder="192Mi" />
          </label>
        </div>
        {usesModel && (
          <>
            <label>
              {t("API keys")}
              <select value={credentialId} onChange={(e) => { setCredentialId(e.target.value); setModel(""); }}>
                <option value="">{t("API key: none yet")}</option>
                {creds.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("Model")}
              <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!credentialId}>
                <option value="">{t("model: job default")}</option>
                {(creds.find((c) => c.id === credentialId)?.models ?? []).map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      <p className="muted small">{t("The new person starts in the team's shared runtime right away; the runtime grows by this share when the team is next idle.")}</p>
      <button type="submit" className="primary">
        {t("Hire")}
      </button>
    </form>
  );
}

function AgentTasks({ agent, snapshot, onOpenTask }: { agent: Agent; snapshot: Snapshot; onOpenTask: (id: string) => void }) {
  const tasks = useMemo(() => snapshot.tasks.filter((x) => x.assigneeAgentId === agent.id), [snapshot.tasks, agent.id]);
  if (!tasks.length) return <p className="muted">{t("No tasks assigned.")}</p>;
  return (
    <ul className="task-list">
      {tasks.map((x) => (
        <li key={x.id}>
          <button type="button" className="task-row stacked" onClick={() => onOpenTask(x.id)}>
            <span className="task-head">
              <StatusPill state={x.status} />
              <span className="task-title">{x.title}</span>
            </span>
            {(x.summary ?? x.statusReason) && (
              <span className="task-summary">
                <ReportText text={x.summary ?? x.statusReason ?? ""} />
              </span>
            )}
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
      {lines.length === 0 && <span className="muted">{t("No work logs yet.")}</span>}
      {lines.map((l) => (
        <div key={l.seq} className={`log-${l.stream}`}>
          <span className="muted">{new Date(l.at).toLocaleTimeString()} </span>
          {l.line}
        </div>
      ))}
    </pre>
  );
}
