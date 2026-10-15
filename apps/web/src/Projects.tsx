import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { askConfirm } from "./dialogs.tsx";
import { t } from "./i18n.ts";
import type { Campaign, Me, Snapshot, Task } from "./types.ts";
import { ago, StatusPill } from "./ui.tsx";

type Notify = (msg: string, kind?: "error" | "info") => void;

const CAMPAIGN_TONE: Record<Campaign["status"], string> = { active: "good", achieved: "info", failed: "bad", stopped: "muted" };

/**
 * Projects, the campaigns inside them and their tasks: where a campaign's
 * progress is followed (an auto campaign's steps and the tasks it handed out).
 */
export function ProjectsView({ snapshot, me, now, notify, onOpenTask }: { snapshot: Snapshot; me: Me; now: number; notify: Notify; onOpenTask: (id: string) => void }) {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [tick, setTick] = useState(0);
  // Task changes arrive live with the snapshot; campaigns are re-read when they do, and every 15 s.
  const taskStamp = snapshot.tasks.map((x) => `${x.id}:${x.status}`).join(",");
  useEffect(() => {
    let live = true;
    api<{ campaigns: Campaign[] }>("GET", "/api/campaigns")
      .then((r) => live && setCampaigns(r.campaigns))
      .catch((e) => live && notify((e as Error).message, "error"));
    const timer = setTimeout(() => setTick((n) => n + 1), 15000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [taskStamp, tick]);
  const refresh = () => setTick((n) => n + 1);

  if (!snapshot.projects.length) {
    return (
      <div className="projects-view">
        <p className="muted">{t("This organization has no projects yet. The owner adds them under Organization → Projects; campaigns live inside them.")}</p>
      </div>
    );
  }
  return (
    <div className="projects-view">
      {snapshot.projects.map((p) => {
        const mine = (campaigns ?? []).filter((c) => c.projectId === p.id);
        const loose = snapshot.tasks.filter((x) => x.projectId === p.id && !x.campaignId);
        return (
          <section key={p.id} className="project-card">
            <header>
              <h3>{p.name}</h3>
              <span className="muted small">
                {t("{c} campaigns · {n} tasks", { c: mine.length, n: snapshot.tasks.filter((x) => x.projectId === p.id).length })}
              </span>
            </header>
            {campaigns === null && <p className="muted small">{t("Loading…")}</p>}
            {mine.map((c) => (
              <CampaignCard key={c.id} c={c} snapshot={snapshot} me={me} now={now} notify={notify} onOpenTask={onOpenTask} onChanged={refresh} />
            ))}
            {loose.length > 0 && (
              <details className="loose-tasks">
                <summary>{t("Tasks not in a campaign ({n})", { n: loose.length })}</summary>
                <TaskRows tasks={loose} snapshot={snapshot} now={now} onOpenTask={onOpenTask} />
              </details>
            )}
            {!mine.length && !loose.length && campaigns !== null && <p className="muted small">{t("Nothing here yet: create a campaign or a task from + New task.")}</p>}
          </section>
        );
      })}
    </div>
  );
}

function CampaignCard({ c, snapshot, me, now, notify, onOpenTask, onChanged }: { c: Campaign; snapshot: Snapshot; me: Me; now: number; notify: Notify; onOpenTask: (id: string) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const tasks = snapshot.tasks.filter((x) => x.campaignId === c.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const total = Object.values(c.tasks).reduce((n, k) => n + k, 0);
  const done = c.tasks.done ?? 0;
  const lead = snapshot.agents.find((a) => a.id === c.leadAgentId)?.displayName ?? c.leadAgentId;
  const canSteer = !!me.actor.owner || c.createdBy === `${me.actor.kind}:${me.actor.id}`;
  const change = async (body: Partial<Pick<Campaign, "mode">> & { status?: "active" | "stopped" }, question?: string) => {
    if (question && !(await askConfirm(question))) return;
    setBusy(true);
    try {
      await api("PATCH", `/api/campaigns/${c.id}`, body);
      onChanged();
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const over = c.status === "achieved" || c.status === "failed";
  return (
    <article className={`campaign-card campaign-${c.status}`}>
      <header>
        <div>
          <h4>{c.title}</h4>
          <span className="muted small">
            {t("Lead: {name}", { name: lead ?? "—" })} · {ago(c.updatedAt, now)}
          </span>
        </div>
        <div className="campaign-tags">
          <span className={`pill pill-${c.mode === "auto" ? "info" : "neutral"}`}>{t(c.mode === "auto" ? "Automatic" : "Manual")}</span>
          <span className={`pill pill-${CAMPAIGN_TONE[c.status]}`}>{t(`campaign ${c.status}`)}</span>
        </div>
      </header>
      <p className="campaign-goal">{c.goal}</p>
      <div className="campaign-progress" aria-label={t("{done} of {total} tasks done", { done, total })}>
        <div className="bar">
          <span style={{ width: total ? `${(100 * done) / total}%` : 0 }} />
        </div>
        <span className="muted small">
          {t("{done}/{total} tasks done", { done, total })}
          {c.mode === "auto" && ` · ${t("step {n}/{max}", { n: c.steps, max: c.maxSteps })}`} · {t("failed {n}/{max}", { n: c.failures, max: c.maxFailures })}
        </span>
      </div>
      {c.summary && <p className={`small ${c.status === "failed" || c.status === "stopped" ? "error" : "ok"}`}>{c.summary}</p>}
      {canSteer && !over && (
        <div className="campaign-actions">
          <label className="switch">
            <input
              type="checkbox"
              checked={c.mode === "auto"}
              disabled={busy}
              onChange={(e) =>
                void change(
                  { mode: e.target.checked ? "auto" : "manual" },
                  e.target.checked ? t("Run {title} automatically? Its waiting tasks start, and {name} keeps going until the goal is met or tasks fail too often.", { title: c.title, name: lead ?? "" }) : undefined,
                )
              }
            />
            <span>{t("Automatic")}</span>
          </label>
          {c.status === "active" ? (
            <button type="button" disabled={busy} onClick={() => void change({ status: "stopped" }, t("Stop {title}? Tasks already running finish; nothing new starts.", { title: c.title }))}>
              {t("Stop")}
            </button>
          ) : (
            <button type="button" className="primary" disabled={busy} onClick={() => void change({ status: "active" })}>
              {t("Resume")}
            </button>
          )}
        </div>
      )}
      {canSteer && over && (
        <div className="campaign-actions">
          <button type="button" disabled={busy} onClick={() => void change({ status: "active" }, t("Reopen {title}? Its failure and step counts start over.", { title: c.title }))}>
            {t("Reopen")}
          </button>
        </div>
      )}
      {tasks.length > 0 && (
        <details className="campaign-tasks" open={c.status === "active" && tasks.length <= 8}>
          <summary>{t("Tasks ({n})", { n: tasks.length })}</summary>
          <TaskRows tasks={tasks} snapshot={snapshot} now={now} onOpenTask={onOpenTask} />
        </details>
      )}
    </article>
  );
}

function TaskRows({ tasks, snapshot, now, onOpenTask }: { tasks: Task[]; snapshot: Snapshot; now: number; onOpenTask: (id: string) => void }) {
  const name = (id: string | null) => snapshot.agents.find((a) => a.id === id)?.displayName ?? "—";
  return (
    <ul className="task-rows">
      {tasks.map((x) => (
        <li key={x.id}>
          <button type="button" onClick={() => onOpenTask(x.id)}>
            {x.campaignStep ? <span className="step-tag">{t("Step {n}", { n: x.campaignStep })}</span> : null}
            <span className="task-title">{x.title}</span>
            <span className="muted small">
              {name(x.assigneeAgentId)} · {ago(x.updatedAt, now)}
            </span>
            <StatusPill state={x.status} />
          </button>
        </li>
      ))}
    </ul>
  );
}
