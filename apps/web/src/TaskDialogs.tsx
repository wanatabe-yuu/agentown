import { useEffect, useState } from "react";
import { api, fetchBlob } from "./api.ts";
import type { Snapshot, TaskDetail } from "./types.ts";
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

          {task.status === "review" && (
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
              <table className="grid">
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
                      <td>#{r.attempt}</td>
                      <td>g{r.runtime_generation}</td>
                      <td>
                        <StatusPill state={r.status} />
                      </td>
                      <td className="muted small">{ago(r.started_at, now)}</td>
                      <td className="small">
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
            {["failed", "blocked"].includes(task.status) && (
              <button type="button" onClick={() => act("Retry", `/api/tasks/${taskId}/retry`)}>
                Retry
              </button>
            )}
            {!["done", "cancelled"].includes(task.status) && (
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

const PLAYBOOKS: Record<string, string[]> = {
  "ceo-launch-site": ["TITLE", "HEADLINE", "GOAL", "LEADER"],
  "lead-build-site": ["TITLE", "HEADLINE"],
  "build-page": ["TITLE", "HEADLINE", "BODY"],
  "qa-page": ["EXPECT_HEADLINE"],
  "workspace-note": ["NOTE"],
  noop: ["MESSAGE"],
};

export function NewTaskDialog({ snapshot, assignee, onClose, notify, onCreated }: { snapshot: Snapshot; assignee: string | null; onClose: () => void; notify: Notify; onCreated: (id: string) => void }) {
  const active = snapshot.agents.filter((a) => a.lifecycleState !== "retired");
  const [to, setTo] = useState(assignee ?? active[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [criteria, setCriteria] = useState("");
  const [project, setProject] = useState("");
  const [kind, setKind] = useState<"playbook" | "prompt" | "script">("playbook");
  const [playbook, setPlaybook] = useState("ceo-launch-site");
  const [args, setArgs] = useState<Record<string, string>>({ TITLE: "Agentown", HEADLINE: "Agents that ship" });
  const [script, setScript] = useState("echo hello from $(hostname)\necho SUMMARY: said hello");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const spec =
      kind === "playbook"
        ? { kind, playbook, args: Object.fromEntries(Object.entries(args).filter(([k, v]) => v && PLAYBOOKS[playbook]!.includes(k))) }
        : kind === "script"
          ? { kind, script }
          : { kind };
    try {
      const r = await api("POST", "/api/tasks", {
        title: title || (kind === "playbook" ? playbook : "Task"),
        description,
        acceptanceCriteria: criteria,
        assigneeAgentId: to,
        projectId: project || null,
        spec,
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
              <option key={a.id} value={a.id}>
                {a.displayName} — {a.jobRole} ({a.id})
              </option>
            ))}
          </select>
        </label>
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should be done?" maxLength={200} />
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
        <fieldset className="seg">
          <legend>Work type</legend>
          {(["playbook", "prompt", "script"] as const).map((k) => (
            <label key={k}>
              <input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} /> {k}
            </label>
          ))}
        </fieldset>
        {kind === "playbook" && (
          <>
            <label>
              Playbook (owner-approved, baked into the runtime image)
              <select value={playbook} onChange={(e) => setPlaybook(e.target.value)}>
                {Object.keys(PLAYBOOKS).map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            {PLAYBOOKS[playbook]!.map((k) => (
              <label key={k}>
                {k}
                <input value={args[k] ?? ""} onChange={(e) => setArgs({ ...args, [k]: e.target.value })} />
              </label>
            ))}
          </>
        )}
        {kind === "prompt" && <p className="muted small">Free-form work for an agent with an LLM harness (e.g. template engineer-claude-v1). Script-harness agents will report it as blocked.</p>}
        {kind === "script" && (
          <label>
            Shell script (counts as exec: needs runtime.exec on the assignee)
            <textarea value={script} onChange={(e) => setScript(e.target.value)} rows={4} className="mono" />
          </label>
        )}
        <label>
          Description
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </label>
        <label>
          Acceptance criteria
          <textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={2} />
        </label>
        <div className="btn-row">
          <button type="submit" className="primary">
            Create task
          </button>
        </div>
      </form>
    </Modal>
  );
}
