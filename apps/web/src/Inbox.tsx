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
};

/** Everything waiting for this person's decision, from the Proposal Engine, with the decision one click away. */
export function NeedsYou({ snapshot, now, refreshKey, onOpenTask, onAgents }: { snapshot: Snapshot; now: number; refreshKey: number; onOpenTask: (id: string) => void; onAgents: (ids: Set<string>) => void }) {
  const [items, setItems] = useState<Proposal[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api<{ proposals: Proposal[] }>("GET", "/api/proposals?status=pending")
      .then((r) => {
        const mine = r.proposals.filter((p) => p.canDecide);
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
            const taskId = p.kind === "task_result" ? (p.payload.taskId as string) : null;
            return (
              <li key={p.id}>
                <button type="button" className="inbox-main" disabled={!taskId} onClick={() => taskId && onOpenTask(taskId)}>
                  <span className="inbox-kind">{t(KIND[p.kind])}</span>
                  <b>{describe(p)}</b>
                  <span className="muted small">
                    {name(p.proposer)} · {ago(p.createdAt, now)}
                  </span>
                </button>
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
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
