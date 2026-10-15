import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t as tr } from "./i18n.ts";
import { AdminDialog } from "./Admin.tsx";
import { AgentPanel } from "./AgentPanel.tsx";
import { AssetsDialog } from "./Assets.tsx";
import { CredentialsDialog } from "./Credentials.tsx";
import { OrgEditor } from "./OrgEditor.tsx";
import { NewTaskDialog, TaskDialog } from "./TaskDialogs.tsx";
import { ProjectsView } from "./Projects.tsx";
import { chatSelectionKey, OwnerChatDialog, type ChatTarget } from "./OwnerChat.tsx";
import { Avatar, AvatarRoster } from "./Avatar.tsx";
import { ConversationsSection } from "./Conversations.tsx";
import { NeedsYou } from "./Inbox.tsx";
import { EVENT_TEXT } from "./activity.ts";
import { languageLabel, t } from "./i18n.ts";
import { SettingsDialog } from "./Settings.tsx";
import { UsersDialog } from "./Users.tsx";
import { HttpError, api, setOrg } from "./api.ts";
import type { Flight } from "./office3d/scene.ts";

// three.js is only downloaded when the office is shown.
const Office3D = lazy(() => import("./office3d/Office3D.tsx"));
// The object panel brings the world schema along: loaded when an object is first picked.
const ObjectPanel = lazy(() => import("./ObjectPanel.tsx").then((m) => ({ default: m.ObjectPanel })));
import { STRUCTURAL, useOffice } from "./store.ts";
import type { Account, AgentEvent, Catalog, Me } from "./types.ts";
import { Menu, type MenuItem, Modal, StatusPill, ago } from "./ui.tsx";

// Tokens used to live in localStorage; the session is an HttpOnly cookie now.
try {
  localStorage.removeItem("agentown.token");
} catch {}

/** The organization in the URL (/o/<id>/…), if any. */
function orgFromUrl(): string | null {
  const m = /^\/o\/([a-z0-9-]+)/.exec(location.pathname);
  return m ? m[1]! : null;
}

/** Signed-in account → pick an organization → the office of that organization. */
export function App() {
  // undefined: still asking the server; null: signed out.
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [orgId, setOrgId] = useState<string | null>(orgFromUrl());
  const [loginError, setLoginError] = useState<string | null>(null);

  const reloadAccount = useCallback(() => {
    api<Account>("GET", "/api/me")
      .then(setAccount)
      .catch(() => setAccount(null));
  }, []);
  useEffect(() => {
    reloadAccount();
    const onPop = () => setOrgId(orgFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  if (account === undefined) return <div className="center muted">{tr("Loading…")}</div>;
  if (!account) {
    return (
      <Login
        error={loginError}
        onToken={(t) =>
          api<Account>("POST", "/api/session", { token: t })
            .then((a) => {
              setLoginError(null);
              setAccount(a);
            })
            .catch((e) => setLoginError(e instanceof HttpError && e.status === 401 ? "That token was rejected." : (e as Error).message))
        }
      />
    );
  }
  const current = account.orgs.find((o) => o.id === orgId) ?? account.orgs[0];
  const signOut = () => void api("DELETE", "/api/session").finally(() => setAccount(null));
  if (!current) {
    return (
      <div className="center">
        <div className="login">
          <h1>{tr("No organization yet")}</h1>
          <p className="muted">You are signed in as {account.user?.displayName}, but you do not belong to any organization. Ask your admin to add you.</p>
          <button type="button" onClick={signOut}>
            {tr("Sign out")}
          </button>
        </div>
      </div>
    );
  }
  setOrg(current.id);
  const switchOrg = (id: string) => {
    history.pushState(null, "", `/o/${id}/`);
    setOrgId(id);
  };
  // A new key per organization: every store, stream and scene starts fresh.
  return (
    <OrgApp
      key={current.id}
      account={account}
      orgId={current.id}
      onSwitch={switchOrg}
      onSignOut={signOut}
      onLost={() => setAccount(null)}
      onAccountChanged={reloadAccount}
    />
  );
}

function OrgApp({
  account,
  orgId,
  onSwitch,
  onSignOut,
  onLost,
  onAccountChanged,
}: {
  account: Account;
  orgId: string;
  onSwitch: (id: string) => void;
  onSignOut: () => void;
  onLost: () => void;
  onAccountChanged: () => void;
}) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showOrg, setShowOrg] = useState(false);
  const [showAssets, setShowAssets] = useState(false);
  const [worldEditing, setWorldEditing] = useState(false);
  const [showUsers, setShowUsers] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedObject, setSelectedObject] = useState<string | null>(null);
  // One thing is inspected at a time: picking an agent closes an object and the other way round.
  const selected = selectedAgent;
  const setSelected = (id: string | null) => {
    setSelectedAgent(id);
    if (id) setSelectedObject(null);
  };
  const selectObject = (id: string | null) => {
    setSelectedObject(id);
    if (id) setSelectedAgent(null);
  };
  // A link can point at one object: …/#object=<id> opens its panel.
  useEffect(() => {
    const open = () => {
      const m = location.hash.match(/^#object=([a-z0-9-]+)$/);
      if (m) selectObject(m[1]!);
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [newTaskFor, setNewTaskFor] = useState<string | null | undefined>(undefined);
  // The 3D office is the default everywhere (it falls back to a flat view without WebGL).
  const [view, setView] = useState<"office" | "table" | "projects">("office");
  const [showAudit, setShowAudit] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [showOwnerChat, setShowOwnerChat] = useState(false);
  const [entityChat, setEntityChat] = useState<ChatTarget | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: number; msg: string; kind: string }>>([]);
  const [flights, setFlights] = useState<Flight[]>([]);
  const dark = useDarkMode();

  const notify = useCallback((msg: string, kind: "error" | "info" = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);

  const reloadMe = useCallback(() => {
    api<Me>("GET", `/api/orgs/${orgId}/me`)
      .then(setMe)
      .catch((e) => e instanceof HttpError && (e.status === 401 || e.status === 404) && onLost());
  }, [orgId]);
  useEffect(reloadMe, [reloadMe]);

  const onEvent = useCallback((e: AgentEvent) => {
    // Permissions may have changed: re-read what this person may do.
    if (STRUCTURAL.test(e.type)) reloadMe();
    if (e.type === "org.config") setCatalog(null); // job templates changed: re-read the catalog
    if (e.type === "task.created" && e.agentId && e.payload.createdBy?.startsWith("agent:")) {
      const from = e.payload.createdBy.slice(6);
      if (from !== e.agentId) {
        const start = performance.now();
        setFlights((f) => [...f.filter((x) => start - x.start < 1500), { from, to: e.agentId!, start, label: e.payload.title }]);
      }
    }
  }, [reloadMe]);

  const { snapshot, status, feed, effectiveWork, now } = useOffice(!!me, onEvent);
  // The open world's own colors (a café's caramel) tint the whole interface.
  const theme = snapshot?.world?.theme;
  useEffect(() => {
    const el = document.documentElement;
    const vars = ["--world-accent", "--world-bg", "--world-ink"];
    if (!theme) {
      delete el.dataset.worldTheme;
      delete el.dataset.worldSurface;
      for (const v of vars) el.style.removeProperty(v);
      return;
    }
    el.dataset.worldTheme = "";
    el.style.setProperty("--world-accent", theme.accent);
    if (theme.surface) {
      el.dataset.worldSurface = "";
      el.style.setProperty("--world-bg", theme.surface);
      el.style.setProperty("--world-ink", theme.ink ?? "#1d1a16");
    } else delete el.dataset.worldSurface;
  }, [theme?.accent, theme?.surface, theme?.ink]);

  useEffect(() => {
    if (me && status === "live" && !catalog) api<Catalog>("GET", "/api/catalog").then(setCatalog).catch(() => {});
  }, [me, status, catalog]);
  useEffect(() => {
    if (status === "unauthorized") onLost();
  }, [status]);

  // "Needs you": agents whose proposals wait for this person (a "?" over their head).
  const [needsOwner, setNeedsOwner] = useState<Set<string>>(new Set());
  const inboxKey = useMemo(() => feed.filter((e) => /^(task\.status|proposal|run\.finished)/.test(e.type)).length, [feed]);

  if (!me) return <div className="center muted">{t("Loading…")}</div>;
  if (!snapshot) return <div className="center muted">{t("Connecting to the office…")}</div>;

  // Everything an owner or admin manages lives in one menu, so the bar stays calm.
  const manageItems: MenuItem[] = [
    ...(me.actor.owner ? [{ label: t("Organization"), hint: t("departments, teams, jobs, permissions"), onSelect: () => setShowOrg(true) }] : []),
    ...(me.can["user.manage"] ? [{ label: t("People"), hint: t("invite, roles, permissions"), onSelect: () => setShowUsers(true) }] : []),
    ...(me.can["credential.manage"] ? [{ label: t("API keys"), hint: t("model providers for agents"), onSelect: () => setShowKeys(true) }] : []),
    ...(me.can["org.design"] ? [{ label: t("Art"), hint: t("3D models and textures"), onSelect: () => setShowAssets(true) }] : []),
    ...(me.can["audit.view"] ? [{ label: t("Audit log"), hint: t("who did what, allowed or denied"), onSelect: () => setShowAudit(true) }] : []),
    ...(account.user?.admin ? [{ label: t("All organizations"), hint: t("instance admin"), onSelect: () => setShowAdmin(true) }] : []),
  ];
  const name = (id: string | null) => snapshot.agents.find((a) => a.id === id)?.displayName ?? id ?? "—";
  const active = snapshot.agents.filter((a) => a.lifecycleState !== "retired");
  const working = active.filter((a) => ["thinking", "executing", "waiting"].includes(effectiveWork(a))).length;

  const openAgentChat = (id: string) => setEntityChat({ type: "agent", id, name: snapshot.agents.find((a) => a.id === id)!.displayName });
  /** Open another conversation at one chat (a reference from the one open now). */
  const openChat = (target: ChatTarget | null, chatId: string) => {
    try {
      localStorage.setItem(chatSelectionKey(orgId, me.actor.id, target), chatId);
    } catch {}
    setEntityChat(target);
    setShowOwnerChat(!target);
  };

  return (
    <AvatarRoster value={{ world: snapshot.world, agents: snapshot.agents, departments: snapshot.departments, me: me.user?.displayName }}>
    <div className={`app${me.actor.owner ? " has-owner-chat" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            ▦
          </span>
          {account.orgs.length > 1 ? (
            <select className="org-switch" value={orgId} onChange={(e) => onSwitch(e.target.value)} aria-label={t("Organization")}>
              {account.orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="org-name">{snapshot.organization.name}</span>
          )}
        </div>
        <div className={`conn conn-${status}`} title={status === "live" ? t("{n} agents · {w} working", { n: active.length, w: working }) : undefined}>
          <span className="dot" aria-hidden />
          <span className="conn-label">{status === "live" ? t("Live") : status === "reconnecting" ? t("Reconnecting…") : t("Connecting…")}</span>
        </div>
        <div className="stats">{t("{n} agents · {w} working", { n: active.length, w: working })}</div>
        <div className="spacer" />
        <div className="seg-toggle" role="group" aria-label={tr("View")}>
          <button type="button" className={view === "office" ? "active" : ""} onClick={() => setView("office")}>
            {t("Office")}
          </button>
          <button type="button" className={view === "table" ? "active" : ""} onClick={() => setView("table")}>
            {t("Table")}
          </button>
          <button type="button" className={view === "projects" ? "active" : ""} onClick={() => setView("projects")}>
            {t("Projects")}
          </button>
        </div>
        <div className="task-actions">
          {me.taskTargets.length > 0 && (
            <button type="button" className="primary new-task" onClick={() => setNewTaskFor(selected && me.taskTargets.includes(selected) ? selected : null)}>
              {t("+ New task")}
            </button>
          )}
          {me.actor.owner && (
            <button type="button" className="owner-chat-button" onClick={() => setShowOwnerChat(true)} aria-label={t("System chat")}>
              <Avatar who={{ type: "system" }} size={20} />
              <span className="btn-text">{t("System chat")}</span>
            </button>
          )}
        </div>
        {manageItems.length > 0 && (
          <Menu
            label={t("Manage")}
            trigger={
              <>
                <span className="btn-icon" aria-hidden>
                  ☰
                </span>
                <span className="btn-text">{t("Manage")} ▾</span>
              </>
            }
            items={manageItems}
          />
        )}
        <Menu
          label={tr("Account")}
          trigger={
            <span className="who">
              <Avatar who={{ type: "you" }} size={24} />
              <span className="who-name">{me.user?.displayName ?? me.actor.id}</span>
            </span>
          }
          header={
            <>
              <b>{me.user?.displayName ?? me.actor.id}</b>
              <small>
                {[me.actor.owner ? t("Owner") : t("Member"), account.user?.admin ? t("Instance admin") : null].filter(Boolean).join(" · ")} {t("of {org}", { org: snapshot.organization.name })}
              </small>
            </>
          }
          items={[
            { label: t("Settings"), hint: t("{system} · {template}", { system: t("System language"), template: languageLabel(snapshot.organization.term) }), onSelect: () => setShowSettings(true) },
            { label: t("Sign out"), onSelect: onSignOut, danger: true },
          ]}
        />
      </header>

      <main className={`main${(selected || selectedObject) && !worldEditing ? " panel-open" : ""}`}>
        <section className={`stage view-${view}`}>
          {view === "office" ? (
            <Suspense fallback={<div className="center muted">{t("Loading the office…")}</div>}>
              <Office3D
                snapshot={snapshot}
                workOf={effectiveWork}
                needsOwner={needsOwner}
                selected={selected}
                onSelect={setSelected}
                onSelectObject={selectObject}
                flights={flights}
                dark={dark}
                canDesign={!!me.can["org.design"]}
                notify={notify}
                onEditingChange={setWorldEditing}
              />
            </Suspense>
          ) : view === "projects" ? (
            <ProjectsView snapshot={snapshot} me={me} now={now} notify={notify} onOpenTask={setOpenTask} />
          ) : (
            <AgentTable snapshot={snapshot} workOf={effectiveWork} now={now} onSelect={setSelected} selected={selected} onChat={me.actor.owner ? openAgentChat : undefined} />
          )}
        </section>

        {worldEditing ? null : selected ? (
          <AgentPanel
            onChat={me.actor.owner ? () => openAgentChat(selected) : undefined}
            agentId={selected}
            snapshot={snapshot}
            catalog={catalog}
            workOf={effectiveWork}
            now={now}
            onClose={() => setSelected(null)}
            onOpenTask={setOpenTask}
            onNewTask={(id) => setNewTaskFor(id)}
            notify={notify}
            canDesign={!!me.can["org.design"]}
          />
        ) : selectedObject ? (
          <Suspense fallback={<aside className="panel agent-panel" />}>
            <ObjectPanel
              objectId={selectedObject}
              snapshot={snapshot}
              canDesign={!!me.can["org.design"]}
              owner={!!me.actor.owner}
              workOf={effectiveWork}
              onSelectAgent={setSelected}
              onOpenChat={me.actor.owner ? openChat : undefined}
              onChat={me.actor.owner ? (id, name) => setEntityChat({ type: "object", id, name }) : undefined}
              onClose={() => setSelectedObject(null)}
              notify={notify}
            />
          </Suspense>
        ) : (
          <aside className="panel side">
            <NeedsYou snapshot={snapshot} now={now} refreshKey={inboxKey} onOpenTask={setOpenTask} onAgents={setNeedsOwner} />
            <ConversationsSection snapshot={snapshot} now={now} onOpenTask={setOpenTask} onChat={me.actor.owner ? setEntityChat : undefined} />
            <section className="feed-section">
              <h3>{t("Activity")}</h3>
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
                {!feed.some((e) => EVENT_TEXT[e.type]) && <li className="muted small">{t("Nothing has happened yet. Click a person to open their desk.")}</li>}
              </ul>
            </section>
          </aside>
        )}
      </main>

      {openTask && <TaskDialog taskId={openTask} snapshot={snapshot} onClose={() => setOpenTask(null)} onOpenTask={setOpenTask} notify={notify} now={now} />}
      {newTaskFor !== undefined && (
        <NewTaskDialog
          snapshot={snapshot}
          me={me}
          catalog={catalog}
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
      {showSettings && <SettingsDialog org={snapshot.organization} kernel={snapshot.kernel} owner={!!me.actor.owner} onClose={() => setShowSettings(false)} />}
      {showKeys && <CredentialsDialog catalog={catalog} onClose={() => setShowKeys(false)} notify={notify} now={now} />}
      {entityChat && me.actor.owner && <OwnerChatDialog agents={snapshot.agents} tasks={snapshot.tasks} key={`${orgId}:${entityChat.type}:${entityChat.id}`} orgId={orgId} ownerId={me.actor.id} orgName={snapshot.organization.name} subject={entityChat} onClose={() => setEntityChat(null)} onKeys={() => { setEntityChat(null); setShowKeys(true); }} onOpenChat={openChat} />}
      {showOwnerChat && me.actor.owner && <OwnerChatDialog agents={snapshot.agents} tasks={snapshot.tasks} orgId={orgId} ownerId={me.actor.id} orgName={snapshot.organization.name} onClose={() => setShowOwnerChat(false)} onKeys={() => { setShowOwnerChat(false); setShowKeys(true); }} onOpenChat={openChat} />}
      {showAssets && <AssetsDialog onClose={() => setShowAssets(false)} notify={notify} />}
      {showOrg && <OrgEditor orgId={orgId} catalog={catalog} snapshot={snapshot} onClose={() => setShowOrg(false)} notify={notify} />}
      {showAdmin && (
        <AdminDialog
          account={account}
          onClose={() => setShowAdmin(false)}
          onChanged={onAccountChanged}
          onOpen={(id) => {
            setShowAdmin(false);
            onSwitch(id);
          }}
          notify={notify}
        />
      )}
      {showUsers && <UsersDialog me={me} catalog={catalog} snapshot={snapshot} onClose={() => setShowUsers(false)} notify={notify} />}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </div>
    </AvatarRoster>
  );
}

function AgentTable({ snapshot, workOf, now, onSelect, selected, onChat }: { onChat?: (id: string) => void; snapshot: NonNullable<ReturnType<typeof useOffice>["snapshot"]>; workOf: ReturnType<typeof useOffice>["effectiveWork"]; now: number; onSelect: (id: string) => void; selected: string | null }) {
  const name = (id: string | null) => snapshot.agents.find((a) => a.id === id)?.displayName ?? "—";
  const teamName = (id: string) => snapshot.teams.find((x) => x.id === id)?.name ?? id;
  // Grouped by team, the way the work is organized.
  const rows = snapshot.agents
    .filter((a) => a.lifecycleState !== "retired")
    .sort((a, b) => teamName(a.teamId).localeCompare(teamName(b.teamId)) || a.displayName.localeCompare(b.displayName));
  return (
    <div className="table-wrap">
      <table className="grid agents">
        <thead>
          <tr>
            <th>{t("Agent")}</th>
            <th>{t("Role")}</th>
            <th>{t("Team")}</th>
            <th>{t("Reports to")}</th>
            <th>{t("Work")}</th>
            <th>{t("Heartbeat")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const dept = snapshot.departments.find((d) => d.id === a.departmentId)?.name;
            const team = teamName(a.teamId);
            return (
              <tr key={a.id} className={selected === a.id ? "selected" : ""} onClick={() => onSelect(a.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSelect(a.id)}>
                <td title={a.id}>
                  <Avatar who={{ type: "agent", id: a.id }} size={24} /> <strong>{a.displayName}</strong>
                  {onChat && (
                    <button type="button" className="agent-chat-shortcut" aria-label={t("Chat with {name}", { name: a.displayName })} onClick={(e) => { e.stopPropagation(); onChat(a.id); }} onKeyDown={(e) => e.stopPropagation()}>
                      {t("Chat")}
                    </button>
                  )}
                </td>
                <td data-label={t("Role")}>{a.jobRole}</td>
                <td data-label={t("Team")}>
                  {team}
                  {dept && dept !== team && <span className="muted small"> · {dept}</span>}
                </td>
                <td data-label={t("Reports to")}>{name(a.reportsToAgentId)}</td>
                <td data-label={t("Work")}>
                  <StatusPill state={workOf(a)} /> <span className="muted small">{a.work.detail}</span>
                </td>
                <td className="muted small" data-label={t("Heartbeat")}>{ago(a.lastHeartbeatAt, now)}</td>
              </tr>
            );
          })}
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
    <Modal title={t("Audit log")} onClose={onClose} wide>
      <label className="small">
        <input type="checkbox" checked={onlyDenied} onChange={(e) => setOnlyDenied(e.target.checked)} /> {t("Denials only")}
      </label>
      <div className="table-wrap">
        <table className="grid mobile-cards">
          <thead>
            <tr>
              <th>{t("When")}</th>
              <th>{t("Actor")}</th>
              <th>{t("Action")}</th>
              <th>{t("Target")}</th>
              <th>{t("Decision")}</th>
              <th>{t("Reason")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <td data-label={tr("When")} className="muted small">{ago(r.at, now)}</td>
                <td data-label={tr("Actor")}>
                  <code>{r.actor}</code>
                </td>
                <td data-label={tr("Action")}>
                  <code>{r.action}</code>
                </td>
                <td data-label={tr("Target")}>{r.target}</td>
                <td data-label={tr("Decision")}>{r.allowed ? <span className="pill pill-good">{t("allowed")}</span> : <span className="pill pill-bad">{t("denied")}</span>}</td>
                <td data-label={tr("Reason")} className="small mobile-wide">{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function Login({ onToken, error }: { onToken: (t: string) => void; error: string | null }) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="center login-page">
      <form
        className="login"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onToken(value.trim());
        }}
      >
        <div className="login-head">
          <span className="logo login-logo" aria-hidden>
            ▦
          </span>
          <div>
            <h1>Agentown</h1>
            <p className="muted small">{tr("A 3D office where your agents work.")}</p>
          </div>
        </div>
        <label className="login-field">
          <span>{tr("Access token")}</span>
          <input ref={ref} type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="aho_…" />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="primary">
          {tr("Enter the office")}
        </button>
        <p className="muted small login-help">
          {tr("The owner runs")} <code>agentownctl token</code> {tr("on the server")} ({tr("or reads")} <code>.agentown/owner-token</code> {tr("when running from source")}); {tr("everyone else gets one from the owner under Members.")}
        </p>
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
