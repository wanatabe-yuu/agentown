import { useEffect, useState } from "react";
import { api, orgPath } from "./api.ts";
import { t } from "./i18n.ts";
import type { Proposal, Snapshot } from "./types.ts";
import { ago } from "./ui.tsx";
import { labels } from "./OwnerChat.tsx";
import { askText } from "./dialogs.tsx";

const KIND: Record<Proposal["kind"], string> = {
  task_result: "Result to review",
  capability_call: "Action to approve",
  config_change: "Configuration",
  world_change: "World change",
  permission_change: "Permission",
  runtime_change: "Runtime",
  team_change: "Team",
  question: "Question",
};

/** A few plain words about what an approval would do, from its arguments. */
function whatItDoes(tool: string, args: Record<string, any>, taskTitle: (id: unknown) => string | null, agentName: (id: unknown) => string | undefined): string[] {
  const out: string[] = [];
  if (tool === "task_action") out.push(t("Task: {title}", { title: taskTitle(args.id) ?? String(args.id ?? "") }));
  if (tool === "create_task") out.push(t("{title} → {name}", { title: String(args.title ?? ""), name: agentName(args.assigneeAgentId) ?? String(args.assigneeAgentId ?? "—") }));
  if (tool === "patch_world" && Array.isArray(args.operations)) {
    for (const op of args.operations.slice(0, 4)) out.push(`${t(String(op.op))} ${String(op.path ?? "")}`);
    if (args.operations.length > 4) out.push(t("and {n} more changes", { n: args.operations.length - 4 }));
  }
  if (tool === "replace_world") {
    const w = args.world as { floors?: Array<{ rooms?: unknown[] }>; objects?: unknown[] } | null;
    out.push(w ? t("New layout: {f} floors, {r} rooms, {o} objects", { f: w.floors?.length ?? 0, r: (w.floors ?? []).reduce((n, f) => n + (f.rooms?.length ?? 0), 0), o: w.objects?.length ?? 0 }) : t("Reset the office to one room per department"));
  }
  if (tool === "upload_asset") out.push(t("Add art: {name}", { name: String(args.name ?? "") }));
  if (tool === "propose_patch") out.push(String(args.title ?? ""));
  if (tool === "connector_call") out.push(t("{tool} on {connector}", { tool: String(args.tool ?? ""), connector: String(args.connector ?? "") }));
  return out.filter(Boolean);
}

/** Everything waiting for this person's decision, from the Proposal Engine, with the decision one click away. */
export function NeedsYou({ snapshot, now, refreshKey, onOpenTask, onAgents }: { snapshot: Snapshot; now: number; refreshKey: number; onOpenTask: (id: string) => void; onAgents: (ids: Set<string>) => void }) {
  const [items, setItems] = useState<Proposal[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api<{ proposals: Proposal[] }>("GET", "/api/proposals?status=pending")
      .then((r) => {
        // Requests the owner left to the lead agent are its job; they stay readable under Conversations → Proposals.
        const mine = r.proposals.filter((p) => p.canDecide && p.approvers?.kind !== "lead");
        setItems(mine);
        onAgents(new Set(mine.flatMap((p) => (p.proposer.startsWith("agent:") ? [p.proposer.slice(6)] : []))));
      })
      .catch(() => setItems((x) => x ?? []));
  useEffect(() => {
    void load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [refreshKey]);
  const agentName = (id: unknown) => snapshot.agents.find((a) => a.id === id)?.displayName;
  /** "Control agent · Linh · restart" rather than a tool id. */
  const describe = (p: Proposal) => {
    if (p.kind === "task_result") return p.title.replace(/^Review: /, "");
    const tool = String(p.payload.capability ?? p.payload.tool ?? "");
    if (!tool) return p.title;
    const args = (p.payload.args ?? {}) as Record<string, unknown>;
    const target = agentName(args.id ?? args.assigneeAgentId) ?? (typeof args.title === "string" ? args.title : null);
    return [t(labels[tool] ?? tool.replace(/_/g, " ")), target, typeof args.action === "string" ? t(args.action) : null].filter(Boolean).join(" · ");
  };
  const name = (ref: string) => (ref.startsWith("agent:") ? snapshot.agents.find((a) => a.id === ref.slice(6))?.displayName ?? ref.slice(6) : ref.startsWith("human:") ? t("You") : ref);
  const decide = async (p: Proposal, verdict: "approve" | "reject") => {
    const note = verdict === "reject" ? await askText(t("Reason for rejecting (optional)"), "", { okLabel: t("Reject") }) : "";
    if (note === null) return;
    setBusy(p.id);
    setError(null);
    try {
      await api("POST", `/api/proposals/${p.id}/decide`, { verdict, note });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const taskTitle = (id: unknown) => snapshot.tasks.find((x) => x.id === id)?.title ?? null;
  const answer = async (p: Proposal, text: string, declined = false) => {
    setBusy(p.id);
    setError(null);
    try {
      await api("POST", `/api/proposals/${p.id}/decide`, { verdict: declined ? "reject" : "approve", note: text });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="needs-you">
      <h3>
        {t("Needs you")} {!!items?.length && <span className="count">{items.length}</span>}
      </h3>
      {error && <p className="error small">{error}</p>}
      {!items?.length ? (
        <p className="muted small">{t("Nothing waiting for you.")}</p>
      ) : (
        <ul className="inbox">
          {items.map((p) => {
            // Results to review open their task; anything an agent asked for during a task links back to it.
            const taskId = (p.payload.taskId as string | undefined) ?? null;
            const from = taskId ? (p.payload.taskTitle as string | undefined) ?? taskTitle(taskId) : null;
            const tool = String(p.payload.capability ?? "");
            const lines = tool ? whatItDoes(tool, (p.payload.args ?? {}) as Record<string, any>, taskTitle, agentName) : [];
            return (
              <li key={p.id} className={`inbox-${p.kind}`}>
                <div className="inbox-main">
                  <span className="inbox-kind">{t(KIND[p.kind])}</span>
                  <b className="inbox-title">{p.kind === "question" ? String(p.payload.question) : describe(p)}</b>
                  {lines.map((l, i) => (
                    <span key={i} className="inbox-line">
                      {l}
                    </span>
                  ))}
                  <span className="muted small">
                    {name(p.proposer)} · {ago(p.createdAt, now)}
                    {from && taskId && (
                      <>
                        {" · "}
                        <button type="button" className="link" onClick={() => onOpenTask(taskId)}>
                          {t("from task: {title}", { title: from })}
                        </button>
                      </>
                    )}
                  </span>
                  {p.kind === "question" && p.payload.deadline && (
                    <span className="muted small">
                      {t("If nobody answers by {time}, {name} decides: {fallback}", {
                        time: new Date(String(p.payload.deadline)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                        name: name(p.proposer),
                        fallback: String(p.payload.fallback ?? t("its own call")),
                      })}
                    </span>
                  )}
                  {tool && (
                    <details className="inbox-details">
                      <summary>{t("Details")}</summary>
                      <pre>{JSON.stringify(p.payload.args ?? {}, null, 2).slice(0, 3000)}</pre>
                    </details>
                  )}
                </div>
                {p.kind === "question" ? (
                  <QuestionReply p={p} busy={busy === p.id} onAnswer={(text, declined) => void answer(p, text, declined)} />
                ) : (
                  <div className="inbox-actions">
                    {p.payload.capability === "propose_patch" && (
                      // Read the whole patch before approving: approved code is built and installed on this host.
                      <a className="btn" href={orgPath(`/api/code/proposals/${encodeURIComponent(p.id)}/diff`)} target="_blank" rel="noreferrer">
                        {t("View diff")}
                      </a>
                    )}
                    <button type="button" className="primary" disabled={busy === p.id} onClick={() => void decide(p, "approve")}>
                      {t("Approve")}
                    </button>
                    <button type="button" disabled={busy === p.id} onClick={() => void decide(p, "reject")}>
                      {t("Reject")}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Pick one of the agent's options, or write an answer; or let it decide. */
function QuestionReply({ p, busy, onAnswer }: { p: Proposal; busy: boolean; onAnswer: (text: string, declined?: boolean) => void }) {
  const [text, setText] = useState("");
  const options = (p.payload.options ?? []) as string[];
  const computer = typeof p.payload.computer === "string" ? p.payload.computer : null;
  return (
    <div className="question-reply">
      {computer && (
        // A login (or anything by hand) on one of the world's computers: open its screen.
        <button type="button" className="primary" onClick={() => { location.hash = ""; location.hash = `object=${computer}`; }}>
          {t("Open computer {id}", { id: computer })}
        </button>
      )}
      {options.length > 0 && (
        <div className="question-options">
          {options.map((o) => (
            <button key={o} type="button" disabled={busy} onClick={() => onAnswer(o)}>
              {o}
            </button>
          ))}
        </div>
      )}
      <form
        className="question-answer"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) onAnswer(text.trim());
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Your answer")} maxLength={2000} aria-label={t("Your answer")} />
        <button type="submit" className="primary" disabled={busy || !text.trim()}>
          {t("Answer")}
        </button>
      </form>
      <button type="button" className="link" disabled={busy} onClick={() => onAnswer("", true)}>
        {t("Let it decide")}
      </button>
    </div>
  );
}
