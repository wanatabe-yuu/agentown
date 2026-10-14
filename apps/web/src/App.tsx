import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentPanel } from "./AgentPanel.tsx";
import { CredentialsDialog } from "./Credentials.tsx";
import { OfficeCanvas } from "./OfficeCanvas.tsx";
import { NewTaskDialog, TaskDialog } from "./TaskDialogs.tsx";
import { api, getToken, setToken } from "./api.ts";
import type { Flight } from "./office.ts";
import { useOffice } from "./store.ts";
import type { AgentEvent, Catalog } from "./types.ts";
import { Modal, StatusPill, ago } from "./ui.tsx";

const EVENT_TEXT: Record<string, (e: AgentEvent, name: (id: string | null) => string) => string> = {
  "agent.spawned": (e, n) => `${n(e.agentId)} joined as ${e.payload.jobRole}${e.payload.reportsTo ? ` under ${n(e.payload.reportsTo)}` : ""}`,
  "agent.active": (e, n) => `${n(e.agentId)}'s runtime is ready`,
  "task.created": (e, n) => `${e.payload.createdBy?.startsWith("agent:") ? n(e.payload.createdBy.slice(6)) : "Owner"} → ${n(e.agentId)}: ${e.payload.title}`,
  "task.status": (e, n) => `${e.payload.title} · ${e.payload.from} → ${e.payload.to}${e.agentId ? ` (${n(e.agentId)})` : ""}`,
  "run.started": (e, n) => `${n(e.agentId)} started ${e.payload.title} (attempt ${e.payload.attempt}, g${e.payload.generation})`,
  "run.finished": (e, n) => `${n(e.agentId)} finished: ${e.payload.outcome}${e.payload.summary ? ` — ${e.payload.summary}` : ""}`,
  "run.lost": (e, n) => `${n(e.agentId)} lost a run: ${e.payload.why}`,
  "artifact.created": (e, n) => `${n(e.agentId)} delivered ${e.payload.name}`,
  "runtime.state": (e, n) => `${n(e.agentId)} runtime: ${e.payload.state}${e.payload.detail ? ` (${e.payload.detail})` : ""}`,
  "runtime.generation": (e, n) => `${n(e.agentId)} runtime replaced → g${e.payload.generation}`,
  "work.state": (e, n) => `${n(e.agentId)} is ${e.payload.state}${e.payload.detail ? `: ${e.payload.detail}` : ""}`,
  "terminal.opened": (e, n) => `terminal opened on ${n(e.agentId)} by ${e.payload.actor}`,
  "terminal.closed": (e, n) => `terminal on ${n(e.agentId)} closed: ${e.payload.reason}`,
  "grant.created": (e, n) => `${n(e.agentId)} received ${e.payload.action}`,
  "grant.revoked": (e, n) => `${n(e.agentId)} lost ${e.payload.action}`,
  "agent.configured": (e, n) => `${n(e.agentId)} now uses ${e.payload.model ?? "the default model"}${e.payload.effort ? ` (${e.payload.effort})` : ""}`,
  "credential.created": (e) => `API key "${e.payload.name}" added (${e.payload.models} models)`,
  "credential.revoked": () => `an API key was revoked`,
};

export function App() {
  const [token, setTok] = useState<string | null>(getToken());
  const [selected, setSelected] = useState<string | null>(null);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [newTaskFor, setNewTaskFor] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<"office" | "table">(() => (window.innerWidth < 700 ? "table" : "office"));
  const [showAudit, setShowAudit] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: number; msg: string; kind: string }>>([]);
  const [flights, setFlights] = useState<Flight[]>([]);
  const dark = useDarkMode();

  const notify = useCallback((msg: string, kind: "error" | "info" = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);

  const onEvent = useCallback((e: AgentEvent) => {
    if (e.type === "task.created" && e.agentId && e.payload.createdBy?.startsWith("agent:")) {
      const from = e.payload.createdBy.slice(6);
      if (from !== e.agentId) {
        const start = performance.now();
        setFlights((f) => [...f.filter((x) => start - x.start < 1500), { from, to: e.agentId!, start, label: e.payload.title }]);
      }
    }
  }, []);

  const { snapshot, status, feed, effectiveWork, now } = useOffice(token, onEvent);

  useEffect(() => {
    if (token && status === "live" && !catalog) api<Catalog>("GET", "/api/catalog").then(setCatalog).catch(() => {});
  }, [token, status, catalog]);

  const needsOwner = useMemo(() => {
    const s = new Set<string>();
    for (const t of snapshot?.tasks ?? []) if (t.status === "review" && t.createdBy.startsWith("human:") && t.assigneeAgentId) s.add(t.assigneeAgentId);
    return s;
  }, [snapshot?.tasks]);
  const reviewTasks = useMemo(() => (snapshot?.tasks ?? []).filter((t) => t.status === "review" && t.createdBy.startsWith("human:")), [snapshot?.tasks]);

  if (!token || status === "unauthorized") {
    return (
      <Login
        error={status === "unauthorized" ? "That token was rejected." : null}
        onToken={(t) => {
          setToken(t);
          setTok(t);
        }}
      />
    );
  }
  if (!snapshot) return <div className="center muted">Connecting to the office…</div>;

  const name = (id: string | null) => snapshot.agents.find((a) => a.id === id)?.displayName ?? id ?? "—";
  const active = snapshot.agents.filter((a) => a.lifecycleState !== "retired");
  const working = active.filter((a) => ["thinking", "executing", "waiting"].includes(effectiveWork(a))).length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            ▦
          </span>{" "}
          {snapshot.organization.name}
        </div>
        <div className={`conn conn-${status}`} title={`event cursor ${snapshot.cursor}`}>
          {status === "live" ? "● live" : status === "reconnecting" ? "◌ reconnecting…" : "◌ connecting…"}
        </div>
        <div className="stats muted">
          {active.length} agents · {working} working
        </div>
        <div className="spacer" />
        <div className="seg-toggle" role="group" aria-label="View">
          <button type="button" className={view === "office" ? "active" : ""} onClick={() => setView("office")}>
            Office
          </button>
          <button type="button" className={view === "table" ? "active" : ""} onClick={() => setView("table")}>
            Table
          </button>
        </div>
        <button type="button" className="primary" onClick={() => setNewTaskFor(null)}>
          New task
        </button>
        <button type="button" onClick={() => setShowKeys(true)}>
          API keys
        </button>
        <button type="button" onClick={() => setShowAudit(true)}>
          Audit
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setToken(null);
            setTok(null);
          }}
        >
          Sign out
        </button>
      </header>

      <main className="main">
        <section className="stage">
          {view === "office" ? (
            <OfficeCanvas snapshot={snapshot} workOf={effectiveWork} needsOwner={needsOwner} selected={selected} onSelect={setSelected} flights={flights} dark={dark} />
          ) : (
            <AgentTable snapshot={snapshot} workOf={effectiveWork} now={now} onSelect={setSelected} selected={selected} />
          )}
          <Legend />
        </section>

        {selected ? (
          <AgentPanel
            agentId={selected}
            snapshot={snapshot}
            catalog={catalog}
            workOf={effectiveWork}
            now={now}
            onClose={() => setSelected(null)}
            onOpenTask={setOpenTask}
            onNewTask={(id) => setNewTaskFor(id)}
            notify={notify}
          />
        ) : (
          <aside className="panel side">
            <section>
              <h3>Needs you {reviewTasks.length > 0 && <span className="count">{reviewTasks.length}</span>}</h3>
              {reviewTasks.length === 0 ? (
                <p className="muted small">Nothing waiting for your review.</p>
              ) : (
                <ul className="task-list">
                  {reviewTasks.map((t) => (
                    <li key={t.id}>
                      <button type="button" className="task-row" onClick={() => setOpenTask(t.id)}>
                        <StatusPill state="review" />
                        <span className="task-title">{t.title}</span>
                        <span className="muted small">{name(t.assigneeAgentId)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="feed-section">
              <h3>Activity</h3>
              <ul className="feed">
                {feed
                  .filter((e) => EVENT_TEXT[e.type])
                  .slice(0, 40)
                  .map((e) => (
                    <li key={e.seq}>
                      <button type="button" className="feed-row" onClick={() => (e.taskId ? setOpenTask(e.taskId) : e.agentId && setSelected(e.agentId))}>
                        <span className="muted small">{ago(e.at, now)}</span> {EVENT_TEXT[e.type]!(e, name)}
                      </button>
                    </li>
                  ))}
                {feed.length === 0 && <li className="muted small">Live events will appear here. Click a person to open their desk.</li>}
              </ul>
            </section>
          </aside>
        )}
      </main>

      {openTask && <TaskDialog taskId={openTask} snapshot={snapshot} onClose={() => setOpenTask(null)} onOpenTask={setOpenTask} notify={notify} now={now} />}
      {newTaskFor !== undefined && (
        <NewTaskDialog
          snapshot={snapshot}
          assignee={newTaskFor}
          onClose={() => setNewTaskFor(undefined)}
          notify={notify}
          onCreated={(id) => {
            setNewTaskFor(undefined);
            setOpenTask(id);
          }}
        />
      )}
      {showAudit && <AuditDialog onClose={() => setShowAudit(false)} now={now} />}
      {showKeys && <CredentialsDialog catalog={catalog} onClose={() => setShowKeys(false)} notify={notify} now={now} />}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

function AgentTable({ snapshot, workOf, now, onSelect, selected }: { snapshot: NonNullable<ReturnType<typeof useOffice>["snapshot"]>; workOf: ReturnType<typeof useOffice>["effectiveWork"]; now: number; onSelect: (id: string) => void; selected: string | null }) {
  const name = (id: string | null) => snapshot.agents.find((a) => a.id === id)?.displayName ?? "—";
  return (
    <div className="table-wrap">
      <table className="grid agents">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Role</th>
            <th>Department</th>
            <th>Reports to</th>
            <th>Work</th>
            <th>Runtime</th>
            <th>Heartbeat</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.agents
            .filter((a) => a.lifecycleState !== "retired")
            .map((a) => (
              <tr key={a.id} className={selected === a.id ? "selected" : ""} onClick={() => onSelect(a.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSelect(a.id)}>
                <td>
                  <strong>{a.displayName}</strong> <code className="muted small">{a.id}</code>
                </td>
                <td>{a.jobRole}</td>
                <td>{snapshot.departments.find((d) => d.id === a.departmentId)?.name}</td>
                <td>{name(a.reportsToAgentId)}</td>
                <td>
                  <StatusPill state={workOf(a)} /> <span className="muted small">{a.work.detail}</span>
                </td>
                <td>
                  <StatusPill state={a.runtime?.state ?? "none"} /> <span className="muted small">g{a.runtime?.generation}</span>
                </td>
                <td className="muted small">{ago(a.lastHeartbeatAt, now)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function AuditDialog({ onClose, now }: { onClose: () => void; now: number }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [onlyDenied, setOnlyDenied] = useState(false);
  useEffect(() => {
    api<{ events: any[] }>("GET", "/api/audit").then((r) => setRows(r.events));
  }, []);
  const shown = (rows ?? []).filter((r) => !onlyDenied || !r.allowed);
  return (
    <Modal title="Audit log" onClose={onClose} wide>
      <label className="small">
        <input type="checkbox" checked={onlyDenied} onChange={(e) => setOnlyDenied(e.target.checked)} /> Denials only
      </label>
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
              <th>Decision</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <td className="muted small">{ago(r.at, now)}</td>
                <td>
                  <code>{r.actor}</code>
                </td>
                <td>
                  <code>{r.action}</code>
                </td>
                <td>{r.target}</td>
                <td>{r.allowed ? <span className="pill pill-good">allowed</span> : <span className="pill pill-bad">denied</span>}</td>
                <td className="small">{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function Legend() {
  return (
    <div className="legend" aria-label="Legend">
      <span>
        <i className="sw sw-good" /> runtime up
      </span>
      <span>
        <i className="sw sw-warn" /> starting
      </span>
      <span>
        <i className="sw sw-bad" /> failed
      </span>
      <span>… thinking</span>
      <span>⌛ waiting</span>
      <span>! blocked</span>
      <span>? needs you</span>
      <span>empty chair = offline</span>
    </div>
  );
}

function Login({ onToken, error }: { onToken: (t: string) => void; error: string | null }) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="center">
      <form
        className="login"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onToken(value.trim());
        }}
      >
        <h1>Agentown</h1>
        <p className="muted">Paste the owner token (written to <code>.agentown/owner-token</code> on first server start).</p>
        <input ref={ref} type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="aho_…" aria-label="Owner token" />
        {error && <p className="error">{error}</p>}
        <button type="submit" className="primary">
          Enter the office
        </button>
      </form>
    </div>
  );
}

function useDarkMode() {
  const q = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const [dark, setDark] = useState(!!q?.matches);
  useEffect(() => {
    if (!q) return;
    const on = () => setDark(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, [q]);
  return dark;
}
