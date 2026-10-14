import { useEffect, useState } from "react";
import { api, fetchBlob } from "./api.ts";
import type { Catalog, Me, Snapshot, TaskDetail } from "./types.ts";
import { Modal, StatusPill, ago } from "./ui.tsx";

type Notify = (msg: string, kind?: "error" | "info") => void;

export function TaskDialog({ taskId, snapshot, onClose, onOpenTask, notify, now }: { taskId: string; snapshot: Snapshot; onClose: () => void; onOpenTask: (id: string) => void; notify: Notify; now: number }) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [note, setNote] = useState("");
  const summary = snapshot.tasks.find((t) => t.id === taskId);

  useEffect(() => {
    api<TaskDetail>("GET", `/api/tasks/${taskId}`)
      .then(setTask)
      .catch((e) => notify(e.message, "error"));
    // Re-read when the task's list entry changes (status, summary).
  }, [taskId, summary?.updatedAt, summary?.status]);

  const name = (id: string | null) => snapshot.agents.find((a) => a.id === id)?.displayName ?? id ?? "—";
  const act = async (label: string, path: string, body: unknown = {}) => {
    try {
      setTask(await api<TaskDetail>("POST", path, body));
      notify(`${label}: ok`, "info");
    } catch (e) {
      notify(`${label}: ${(e as Error).message}`, "error");
    }
  };
  const openArtifact = async (id: string) => {
    const blob = await fetchBlob(`/api/artifacts/${id}`);
    // Open as plain text so agent-produced HTML never runs in our origin.
    const text = await blob.text();
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    window.open(url, "_blank", "noopener");
  };
  const children = snapshot.tasks.filter((t) => t.parentTaskId === taskId);

  return (
    <Modal title={task?.title ?? "Task"} onClose={onClose} wide>
      {!task ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="task-detail">
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
            {task.summary && (
              <>
                <div>Summary</div>
                <div>{task.summary}</div>
              </>
            )}
            {task.acceptanceCriteria && (
              <>
                <div>Acceptance</div>
                <div>{task.acceptanceCriteria}</div>
              </>
            )}
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
                        {r.summary}
                        {r.usage && <div className="muted">usage: {JSON.stringify(r.usage)}</div>}
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
                    <button type="button" className="link" onClick={() => openArtifact(a.id)}>
                      {a.name}
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
