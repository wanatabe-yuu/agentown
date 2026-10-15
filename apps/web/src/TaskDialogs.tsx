import { useEffect, useState } from "react";
import { api, fetchBlob, HttpError, orgPath } from "./api.ts";
import type { Catalog, Me, Snapshot, TaskDetail, TaskProgress } from "./types.ts";
import { Modal, StatusPill, ago } from "./ui.tsx";
import { ReportText } from "./Markdown.tsx";

type Notify = (msg: string, kind?: "error" | "info") => void;

export function TaskDialog({ taskId, snapshot, onClose, onOpenTask, notify, now }: { taskId: string; snapshot: Snapshot; onClose: () => void; onOpenTask: (id: string) => void; notify: Notify; now: number }) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [progress, setProgress] = useState<TaskProgress | null>(null);
  const [refreshError, setRefreshError] = useState("");
  const [artifact, setArtifact] = useState<{ name: string; text: string } | null>(null);
  const [openingArtifact, setOpeningArtifact] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [note, setNote] = useState("");
  const summary = snapshot.tasks.find((t) => t.id === taskId);
  const taskPath = orgPath(`/api/tasks/${encodeURIComponent(taskId)}`);

  useEffect(() => {
    setTask(null); setProgress(null); setArtifact(null); setNote("");
  }, [taskId]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = await api<TaskDetail>("GET", taskPath);
        if (disposed) return;
        // If this read sees completion, the subsequent activity read also sees
        // its committed final receipt instead of stopping on an older snapshot.
        const activity = await api<TaskProgress>("GET", `${taskPath}/progress`);
        if (disposed) return;
        setTask(next); setProgress(activity); setRefreshError("");
        if (["queued", "assigned", "in_progress", "review"].includes(next.status)) timer = setTimeout(read, 1500);
      } catch (e) {
        if (disposed) return;
        setRefreshError((e as Error).message);
        if (e instanceof HttpError && [401, 403, 404].includes(e.status)) { setTask(null); setProgress(null); return; }
        timer = setTimeout(read, 3000);
      }
    };
    void read();
    return () => { disposed = true; clearTimeout(timer); };
  }, [taskPath, summary?.updatedAt, summary?.status, reload]);

  const name = (id: string | null) => snapshot.agents.find((a) => a.id === id)?.displayName ?? id ?? "—";
  const act = async (label: string, path: string, body: unknown = {}) => {
    try {
      setTask(await api<TaskDetail>("POST", path, body));
      setReload(n => n + 1);
      notify(`${label}: ok`, "info");
    } catch (e) {
      notify(`${label}: ${(e as Error).message}`, "error");
    }
  };
  const openArtifact = async (id: string, name: string) => {
    setOpeningArtifact(id);
    try {
      const blob = await fetchBlob(`/api/artifacts/${id}`);
      // Blob.text decodes UTF-8; React escapes agent HTML. No browser charset
      // guessing or asynchronous popup is involved, including on mobile.
      setArtifact({ name, text: await blob.text() });
    } catch (e) { notify(`Open file: ${(e as Error).message}`, "error"); }
    finally { setOpeningArtifact(null); }
  };
  const children = snapshot.tasks.filter((t) => t.parentTaskId === taskId);

  if (artifact) return <Modal key="artifact" title={artifact.name} onClose={() => setArtifact(null)} wide>
    <button type="button" onClick={() => setArtifact(null)}>← Back to task</button>
    <p className="muted small">File preview · UTF-8</p>
    {/\.md$/i.test(artifact.name) ? <ReportText text={artifact.text} /> : <pre className="artifact-text-preview">{artifact.text}</pre>}
  </Modal>;
  return (
    <Modal key="task" title={task?.title ?? "Task"} onClose={onClose} wide>
      {refreshError && <p className="error" role="status">Couldn't refresh task: {refreshError}</p>}
      {!task ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="task-detail">
          <TaskActivity task={task} progress={progress} now={now} agents={snapshot.agents} />
          <details className="task-original-request">
            <summary>Original request</summary>
            <div className="task-request-text">{task.description || "No prompt provided."}</div>
            {task.acceptanceCriteria && <><h4>Acceptance criteria</h4><div className="task-request-text">{task.acceptanceCriteria}</div></>}
          </details>
          <div className="kv">
            <div>Status</div>
            <div>
              <StatusPill state={task.status} /> {task.statusReason && <span className="muted">{task.statusReason}</span>}
            </div>
            <div>Assignee</div>
            <div>{name(task.assigneeAgentId)}</div>
            <div>Created by</div>
            <div>{task.createdBy.startsWith("agent:") ? name(task.createdBy.slice(6)) : task.createdBy}</div>
            <div>Spec</div>
            <div>
              <code>{task.spec.kind === "playbook" ? `playbook ${task.spec.playbook}` : task.spec.kind}</code>
              {task.spec.args && <span className="muted small"> {Object.entries(task.spec.args).map(([k, v]) => `${k}=${v}`).join(" ")}</span>}
            </div>
            {task.parentTaskId && (
              <>
                <div>Parent</div>
                <div>
                  <button type="button" className="link" onClick={() => onOpenTask(task.parentTaskId!)}>
                    {snapshot.tasks.find((t) => t.id === task.parentTaskId)?.title ?? task.parentTaskId}
                  </button>
                </div>
              </>
            )}
          </div>

          {task.can.review && (
            <section className="review-box">
              <h3>Waiting for your review</h3>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" rows={2} />
              <div className="btn-row">
                <button type="button" className="primary" onClick={() => act("Approve", `/api/tasks/${taskId}/review`, { decision: "approve", note })}>
                  Approve
                </button>
                <button type="button" onClick={() => act("Request changes", `/api/tasks/${taskId}/review`, { decision: "reject", note })}>
                  Request changes
                </button>
              </div>
            </section>
          )}

          {children.length > 0 && (
            <section>
              <h3>Subtasks</h3>
              <ul className="task-list">
                {children.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="task-row" onClick={() => onOpenTask(c.id)}>
                      <StatusPill state={c.status} />
                      <span className="task-title">{c.title}</span>
                      <span className="muted small">→ {name(c.assigneeAgentId)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3>Runs</h3>
            {task.runs.length === 0 ? (
              <p className="muted small">Not started.</p>
            ) : (
              <table className="grid task-runs">
                <thead>
                  <tr>
                    <th>Attempt</th>
                    <th>Runtime</th>
                    <th>Status</th>
                    <th>Started</th>
                    <th>Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {task.runs.map((r) => (
                    <tr key={r.id}>
                      <td data-label="Attempt">#{r.attempt}</td>
                      <td data-label="Runtime">g{r.runtime_generation}</td>
                      <td data-label="Status">
                        <StatusPill state={r.status} />
                      </td>
                      <td data-label="Started" className="muted small">{ago(r.started_at, now)}</td>
                      <td data-label="Summary" className="small">
                        {r.summary && <details className="run-report"><summary>Agent report</summary><ReportText text={r.summary} /></details>}
                        {r.usage && <details className="run-usage"><summary>Usage details</summary><pre>{JSON.stringify(r.usage, null, 2)}</pre></details>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h3>Artifacts</h3>
            {task.artifacts.length === 0 ? (
              <p className="muted small">None.</p>
            ) : (
              <ul className="artifacts">
                {task.artifacts.map((a) => (
                  <li key={a.id}>
                    <button type="button" className="link" disabled={openingArtifact !== null} onClick={() => openArtifact(a.id, a.name)}>
                      {openingArtifact === a.id ? "Opening…" : a.name}
                    </button>{" "}
                    <span className="muted small">
                      {a.size} B · sha256 {a.sha256.slice(0, 12)}…
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="btn-row">
            {task.can.retry && (
              <button type="button" onClick={() => act("Retry", `/api/tasks/${taskId}/retry`)}>
                Retry
              </button>
            )}
            {task.can.cancel && (
              <button type="button" className="danger" onClick={() => act("Cancel", `/api/tasks/${taskId}/cancel`, { reason: "cancelled from UI" })}>
                Cancel task
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

const workLabels: Record<string, string> = { thinking: "Thinking", executing: "Running a command", waiting: "Waiting for a dependency", blocked: "Needs attention", offline: "Waiting for the agent to reconnect", error: "Agent reported an error", idle: "Preparing the next step" };
function TaskActivity({ task, progress, now, agents }: { task: TaskDetail; progress: TaskProgress | null; now: number; agents: Snapshot["agents"] }) {
  const run = task.runs.at(-1);
  const active = task.status === "in_progress" && run?.status === "running";
  const heartbeatStale = active && (!progress?.current?.heartbeatAt || now - Date.parse(progress.current.heartbeatAt) > 30000);
  const resultReady = ["review", "done"].includes(task.status);
  const title = task.status === "done" ? "Task complete" : task.status === "review" ? "Result ready · waiting for review" :
    task.status === "failed" ? "Task failed" : task.status === "blocked" ? "Task needs attention" : task.status === "cancelled" ? "Task cancelled" :
    active ? heartbeatStale ? "Waiting for an update" : workLabels[progress?.current?.state ?? "thinking"] ?? "Working" : task.assigneeAgentId ? "Waiting to start" : "Waiting for an assignee";
  const steps = ["Created", "Processing", "Result ready", task.requiresReview ? "Approved" : "Complete"];
  const stage = task.status === "done" ? 3 : resultReady ? 2 : active || !!run ? 1 : 0;
  const duration = run ? Math.max(0, Math.floor(((run.finished_at ? Date.parse(run.finished_at) : now) - Date.parse(run.started_at)) / 1000)) : 0;
  const elapsed = duration >= 60 ? `${Math.floor(duration / 60)}m ${duration % 60}s` : `${duration}s`;
  const events = progress?.events.slice(-16).reverse() ?? [];
  const result = task.summary || task.statusReason;
  const preview = result?.replace(/[*#`_|>]+/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
  return <section className={`task-progress task-progress-${task.status}`} aria-label="Task progress">
    <div className="task-progress-heading"><h3>{title}</h3>{active && <span className="task-live-indicator">Live</span>}</div>
    <ol className="task-progress-stages" aria-label="Task stages">{steps.map((step, n) => <li key={step} className={n < stage || task.status === "done" ? "complete" : n === stage ? "current" : ""} aria-current={n === stage ? "step" : undefined}><span aria-hidden>{n < stage || task.status === "done" ? "✓" : n + 1}</span>{step}</li>)}</ol>
    <p className="muted small">Attempt {task.attempt} / {task.maxAttempts ?? 5}{run ? ` · ${run.finished_at ? "Ran for" : "Elapsed"} ${elapsed}` : ""}{progress?.current?.heartbeatAt && active ? ` · Last contact ${ago(progress.current.heartbeatAt, now)}` : ""}</p>
    {active && heartbeatStale && <p className="muted small">No recent heartbeat. Completed activity is preserved; waiting for the runtime to reconnect.</p>}
    {active && progress?.current?.detail && !heartbeatStale && <p className="task-current-action">{progress.current.detail}</p>}
    <ConfigurationResult task={task} agents={agents} />
    {result && (result.length > 240 ? <details className="task-progress-result"><summary><strong>Agent report · View full summary</strong><span className="task-result-preview">{preview}…</span></summary><ReportText text={result} /></details> : <div className="task-progress-result"><strong>Agent report</strong><ReportText text={result} /></div>)}
    {result && <p className="muted small">The report records what the agent said at that time. Saved configuration changes and current settings are shown separately below.</p>}
    {!!task.artifacts.length && <p className="small">{task.artifacts.length} {task.artifacts.length === 1 ? "file" : "files"} available below.</p>}
    {events.length > 0 && <details className="task-progress-timeline" open><summary>Activity</summary><ol>{events.map(e => <li key={e.seq}><time dateTime={e.at} title={new Date(e.at).toLocaleString()}>{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><div><span>{e.message}</span>{e.detail && <p>{e.detail}</p>}</div></li>)}</ol></details>}
    {progress?.canReadLogs && <details className="task-output"><summary>Execution log · attempt {run?.attempt}</summary><pre>{progress.logs.length ? progress.logs.map(l => `[${new Date(l.at).toLocaleTimeString()}] ${l.stream}: ${l.line}`).join("\n") : "No output yet."}</pre></details>}
  </section>;
}

const settingLabels: Record<string, string> = { model: "Model", effort: "Effort", credentialId: "Saved key", maxTurns: "Steps per task", contextLimit: "Context budget" };
const settingValue = (key: string, value: unknown) => value == null ? "Provider default / not configured" : key === "contextLimit" ? `${Number(value).toLocaleString()} tokens` : String(value);
function ConfigurationResult({ task, agents }: { task: TaskDetail; agents: Snapshot["agents"] }) {
  const changes = task.configurationChanges ?? [];
  return <div className="task-configuration">
    {changes.some(c => c.changedSince) && <p className="config-history-notice">Some settings changed again after this task. Its historical report does not describe the current configuration.</p>}
    <details className="config-receipts"><summary>Saved configuration changes · {changes.length} server records</summary>
      {!changes.length && <p className="muted small">No configuration write is recorded for this task. An agent report alone does not verify a change.</p>}
      {changes.map(c => <article key={c.id}><strong>{c.name} · {c.changed === false ? "Already matched" : c.changed ? "Saved change" : "Historical record"}</strong><p className="muted small">{new Date(c.at).toLocaleString()}{c.revision ? ` · revision ${c.revision}` : ""} · {c.linked ? "Linked task receipt" : "Recorded while this agent was running the task"}</p>
        {Object.entries(c.saved).filter(([key]) => key in settingLabels).map(([key, saved]) => <div className="config-receipt-field" key={key}><span className="muted">{settingLabels[key]}</span><span>{c.before && key in c.before ? `${settingValue(key, c.before[key])} → ` : ""}{settingValue(key, saved)}</span>{c.current[key] !== saved && <small>Current: {settingValue(key, c.current[key])} · changed later</small>}</div>)}
      </article>)}
    </details>
    <details className="config-current-world"><summary>Current world configuration</summary><p className="muted small">Live saved settings. Context budget does not increase a provider's model window.</p><div className="report-table-scroll"><table><thead><tr><th>Agent</th><th>Model</th><th>Effort</th><th>Context budget</th></tr></thead><tbody>{agents.filter(a => a.lifecycleState !== "retired").map(a => <tr key={a.id}><th>{a.displayName}</th><td>{a.config.model ?? "Template default"}</td><td>{a.config.effort ?? "Provider default"}</td><td>{a.config.contextLimit?.toLocaleString() ?? "Provider default"}</td></tr>)}</tbody></table></div></details>
  </div>;
}

export function NewTaskDialog({ snapshot, me, catalog, assignee, onClose, notify, onCreated }: { snapshot: Snapshot; me: Me; catalog: Catalog | null; assignee: string | null; onClose: () => void; notify: Notify; onCreated: (id: string) => void }) {
  // Only agents this person may give work to.
  const active = snapshot.agents.filter((a) => a.lifecycleState !== "retired" && me.taskTargets.includes(a.id));
  // Not a permission: work is a prompt, so it needs a model. Agents without one only walk around the office.
  const why = (a: (typeof active)[number]) =>
    catalog?.presets.find((p) => p.id === a.runtime?.presetId)?.harness === "script" ? "no LLM runtime" : !a.config.credentialId ? "no API key" : null;
  const [to, setTo] = useState(assignee ?? active.find((a) => !why(a))?.id ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [criteria, setCriteria] = useState("");
  const [project, setProject] = useState("");
  const target = active.find((a) => a.id === to);
  const blocked = target ? why(target) : "no assignee";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api("POST", "/api/tasks", {
        title,
        description,
        acceptanceCriteria: criteria,
        assigneeAgentId: to,
        projectId: project || null,
        spec: { kind: "prompt" },
      });
      notify(`Task ${r.task.id} → ${to}`, "info");
      onCreated(r.task.id);
    } catch (err) {
      notify(`Create task: ${(err as Error).message}`, "error");
    }
  };

  return (
    <Modal title="New task" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Assignee
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            {active.map((a) => (
              <option key={a.id} value={a.id} disabled={!!why(a)}>
                {a.displayName} — {a.jobRole}
                {why(a) ? ` · ${why(a)}` : ""}
              </option>
            ))}
          </select>
        </label>
        {target && blocked && <p className="error small">{target.displayName} has {blocked}: give it an API key in its Config tab.</p>}
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should be done?" maxLength={200} required />
        </label>
        <label>
          Prompt
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} placeholder="Describe the work in plain words." required />
        </label>
        <label>
          Acceptance criteria
          <textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={2} placeholder="How you will judge it is done (optional)" />
        </label>
        <label>
          Project
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">— none —</option>
            {snapshot.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="btn-row">
          <button type="submit" className="primary" disabled={!!blocked}>
            Create task
          </button>
        </div>
      </form>
    </Modal>
  );
}
