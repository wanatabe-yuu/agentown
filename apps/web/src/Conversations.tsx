import { useEffect, useRef, useState } from "react";
import { t as tr } from "./i18n.ts";
import { api } from "./api.ts";
import type { ChatTarget } from "./OwnerChat.tsx";
import type { FeedItem, FeedKind, Snapshot, TeamMessage } from "./types.ts";
import { Modal, StatusPill, ago } from "./ui.tsx";
import { t } from "./i18n.ts";
import { EVENT_TEXT, plain } from "./activity.ts";
import { ReportText } from "./Markdown.tsx";
import { Avatar } from "./Avatar.tsx";

type Filter = "you" | "team" | "other";

const FILTERS: Array<{ id: Filter; label: string; hint: string }> = [
  { id: "you", label: "You", hint: "Your conversations with each person and object" },
  { id: "team", label: "Team", hint: "Conversations inside each team" },
  { id: "other", label: "Other", hint: "Self-talk, proposals, tools and everything else" },
];

const OTHER: Array<{ kind: FeedKind; label: string; hint: string }> = [
  { kind: "self", label: "Thinking", hint: "Agents reasoning while they work" },
  { kind: "proposal", label: "Proposals", hint: "Waiting for approval, reviews, configuration changes" },
  { kind: "tool", label: "Tools", hint: "Commands and actions agents ran" },
  { kind: "event", label: "Events", hint: "Assignments, results, runtimes" },
];

const FILTER_KEY = "agentown.conversations.filter";

/** One place for every conversation: yours, your teams', and everything else agents say and do. */
export function ConversationsSection({ snapshot, onChat, onOpenTask, now }: { snapshot: Snapshot; onChat?: (t: ChatTarget) => void; onOpenTask: (id: string) => void; now: number }) {
  const [filter, setFilter] = useState<Filter>(() => {
    try {
      const v = localStorage.getItem(FILTER_KEY);
      if (v === "you" || v === "team" || v === "other") return v;
    } catch {}
    return "you";
  });
  const [team, setTeam] = useState<string | null>(null);
  const [other, setOther] = useState<FeedKind | null>(null);
  const choose = (f: Filter) => {
    setFilter(f);
    try {
      localStorage.setItem(FILTER_KEY, f);
    } catch {}
  };
  const people = snapshot.agents.filter((a) => a.lifecycleState !== "retired");
  // Only objects that talk have a conversation (see canTalk in the world schema).
  const objects = snapshot.world?.objects.filter((o) => o.id && (o.chat?.enabled ?? snapshot.world!.kinds[o.kind]?.chat?.enabled ?? !!snapshot.world!.kinds[o.kind]?.chat)) ?? [];
  const teams = snapshot.teams.filter((t) => t.memberIds.length > 0 || !t.implicit);

  return (
    <section className="conversations">
      <div className="conv-head">
        <h3>{t("Conversations")}</h3>
        <select value={filter} onChange={(e) => choose(e.target.value as Filter)} aria-label={t("Filter conversations")}>
          {FILTERS.map((f) => (
            <option key={f.id} value={f.id}>
              {t(f.label)}
            </option>
          ))}
        </select>
      </div>
      <p className="muted small">{t(FILTERS.find((f) => f.id === filter)!.hint)}</p>
      <ul className="conv-list">
        {filter === "you" &&
          (onChat ? (
            <>
              {people.map((a) => (
                <li key={a.id}>
                  <button type="button" className="conv-row" onClick={() => onChat({ type: "agent", id: a.id, name: a.displayName })}>
                    <Avatar who={{ type: "agent", id: a.id }} size={34} />
                    <span className="conv-main">
                      <b>{a.displayName}</b>
                      <span className="muted small">{a.jobRole} · {snapshot.teams.find((t) => t.id === a.teamId)?.name ?? a.teamId}</span>
                    </span>
                    <StatusPill state={a.work.state} />
                  </button>
                </li>
              ))}
              {objects.map((o) => {
                const kind = snapshot.world!.kinds[o.kind];
                return (
                  <li key={o.id}>
                    <button type="button" className="conv-row" onClick={() => onChat({ type: "object", id: o.id!, name: o.label || kind?.name || o.kind })}>
                      <Avatar who={{ type: "object", id: o.id! }} size={34} />
                      <span className="conv-main">
                        <b>{o.label || kind?.name}</b>
                        <span className="muted small">{o.title || kind?.title || kind?.category || t("object")}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </>
          ) : (
            <li className="muted small">{t("Only the owner can chat privately with people and objects.")}</li>
          ))}
        {filter === "team" &&
          teams.map((tm) => (
            <li key={tm.id}>
              <button type="button" className="conv-row" onClick={() => setTeam(tm.id)}>
                <span className="conv-avatar team" aria-hidden>#</span>
                <span className="conv-main">
                  <b>{tm.name}</b>
                  <span className="muted small">
                    {snapshot.departments.find((d) => d.id === tm.departmentId)?.name} · {t("{n} people", { n: tm.memberIds.length })}
                  </span>
                </span>
                {tm.runtime && <StatusPill state={tm.runtime.state} />}
              </button>
            </li>
          ))}
        {filter === "other" &&
          OTHER.map((o) => (
            <li key={o.kind}>
              <button type="button" className="conv-row" onClick={() => setOther(o.kind)}>
                <span className={`conv-avatar kind-${o.kind}`} aria-hidden>{t(o.label).slice(0, 1)}</span>
                <span className="conv-main">
                  <b>{t(o.label)}</b>
                  <span className="muted small">{t(o.hint)}</span>
                </span>
              </button>
            </li>
          ))}
      </ul>
      {team && <TeamChatDialog teamId={team} snapshot={snapshot} now={now} onClose={() => setTeam(null)} />}
      {other && <FeedDialog kind={other} snapshot={snapshot} now={now} onClose={() => setOther(null)} onOpenTask={(id) => { setOther(null); onOpenTask(id); }} />}
    </section>
  );
}

function TeamChatDialog({ teamId, snapshot, now, onClose }: { teamId: string; snapshot: Snapshot; now: number; onClose: () => void }) {
  const team = snapshot.teams.find((t) => t.id === teamId);
  const [messages, setMessages] = useState<TeamMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const load = () =>
    api<{ messages: TeamMessage[] }>("GET", `/api/teams/${teamId}/messages`)
      .then((r) => {
        setMessages(r.messages);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    void load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [teamId]);
  // Not an expression body: scrollIntoView returns a Promise in newer browsers, which React would call as a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages?.length]);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    try {
      await api("POST", `/api/teams/${teamId}/messages`, { text });
      setText("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };
  const members = snapshot.agents.filter((a) => team?.memberIds.includes(a.id));
  return (
    <Modal title={`Team · ${team?.name ?? teamId}`} onClose={onClose} wide className="team-chat">
      <p className="muted small">
        {members.map((m) => m.displayName).join(", ") || t("No one yet")}
        {team?.runtime && <> {tr("· runtime")} <StatusPill state={team.runtime.state} /> g{team.runtime.generation}{team.runtime.resources ? ` · ${team.runtime.resources.cpu}m / ${team.runtime.resources.memory}Mi` : ""}</>}
      </p>
      {error && <p className="error small">{error}</p>}
      <div className="team-messages" aria-live="polite">
        {messages === null && <p className="muted">{t("Loading…")}</p>}
        {messages?.length === 0 && <p className="muted">{t("No messages yet. Team members post here with `agentown team say`.")}</p>}
        {messages?.map((m) => (
          <div key={m.id} className={`team-msg${m.system ? " system" : ""}${m.author.kind === "human" ? " human" : ""}`}>
            <span className="team-msg-author"><Avatar who={m.author.kind === "agent" ? { type: "agent", id: m.author.id } : { type: "you" }} size={20} /> {m.author.name}</span>
            <span className="team-msg-text">
              {m.system ? (m.event && EVENT_TEXT[m.event.type] ? EVENT_TEXT[m.event.type]!(m.event, () => m.author.name).replace(`${m.author.name} `, "") : plain(m.text)) : <ReportText text={m.text} />}
            </span>
            <span className="muted small">{ago(m.at, now)}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form className="team-composer" onSubmit={send}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Message the team…")} maxLength={4000} aria-label={t("Message to the team")} />
        <button type="submit" className="primary" disabled={sending || !text.trim()}>
          {t("Send")}
        </button>
      </form>
    </Modal>
  );
}

function FeedDialog({ kind, snapshot, now, onClose, onOpenTask }: { kind: FeedKind; snapshot: Snapshot; now: number; onClose: () => void; onOpenTask: (id: string) => void }) {
  const [team, setTeam] = useState("");
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const label = OTHER.find((o) => o.kind === kind)!;
  useEffect(() => {
    let live = true;
    const load = () =>
      api<{ items: FeedItem[] }>("GET", `/api/feed?kind=${kind}${team ? `&teamId=${encodeURIComponent(team)}` : ""}`)
        .then((r) => live && (setItems(r.items), setError(null)))
        .catch((e) => live && setError((e as Error).message));
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [kind, team, tick]);
  const decide = async (id: string, verdict: "approve" | "reject") => {
    const note = verdict === "reject" ? prompt(t("Reason for rejecting (optional)")) ?? "" : "";
    setBusy(id);
    try {
      await api("POST", `/api/proposals/${id}/decide`, { verdict, note });
      setTick((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const name = (id: string | null) => snapshot.agents.find((a) => a.id === id)?.displayName ?? (id ? id : t("You"));
  return (
    <Modal title={`${t("Other")} · ${t(label.label)}`} onClose={onClose} wide className="feed-dialog">
      <div className="form-row">
        <span className="muted small">{t(label.hint)}</span>
        <span className="spacer" />
        <select value={team} onChange={(e) => setTeam(e.target.value)} aria-label={tr("Team")}>
          <option value="">{t("All teams")}</option>
          {snapshot.teams.filter((t) => t.memberIds.length).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="error small">{error}</p>}
      {items === null && <p className="muted">{t("Loading…")}</p>}
      {items?.length === 0 && <p className="muted">{t("Nothing yet.")}</p>}
      <ul className="feed other-feed">
        {items?.map((i) => (
          <li key={i.id} className={i.canDecide ? "decidable" : ""}>
            <button type="button" className={`feed-row kind-${i.kind}`} disabled={!i.taskId} onClick={() => i.taskId && onOpenTask(i.taskId)}>
              <span className="muted small">{ago(i.at, now)}</span> <b>{name(i.agentId)}</b>{" "}
              {i.kind === "proposal" || i.kind === "tool" ? <span className="tag">{i.title}</span> : null}
              {i.status && <StatusPill state={i.status} />}
              {" "}<span className={i.kind === "tool" ? "mono" : ""}>
                {i.event && EVENT_TEXT[i.event.type] ? EVENT_TEXT[i.event.type]!(i.event, name).replace(`${name(i.agentId)} `, "") : i.kind === "self" || i.kind === "event" ? plain(i.text) : i.text}
              </span>
            </button>
            {i.canDecide && i.proposalId && (
              <div className="btn-row decide-row">
                <button type="button" className="primary" disabled={busy === i.proposalId} onClick={() => void decide(i.proposalId!, "approve")}>
                  {t("Approve")}
                </button>
                <button type="button" disabled={busy === i.proposalId} onClick={() => void decide(i.proposalId!, "reject")}>
                  {t("Reject")}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
