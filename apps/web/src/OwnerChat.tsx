import { ReportText } from "./Markdown.tsx";
import { t } from "./i18n.ts";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { api, HttpError } from "./api.ts";
import { Menu, Modal } from "./ui.tsx";
import { requestId } from "./requestId.ts";
import { Avatar, WhoName, type Who } from "./Avatar.tsx";

interface Config { credentialId: string; model: string; effort: string | null; contextLimit: number; maxOutputTokens: number; maxTurns: number; approvalMode: "important" | "all" }
interface Chat { id: string; title: string; archivedAt: string | null; config: Config; contextTokens: number; countMode: string; modelInfo: { contextWindow: number | null; nativeCompaction: boolean; efforts: string[] | null } | null; usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; compactions?: number; incompleteRequests?: number } }
interface Credential { id: string; name: string; provider: string; models: string[] }
interface Entry { id: string; role: string; text: string; partial: boolean; run_id: string; created_at: string; author_type: "agent" | "object" | null; author_id: string | null }
interface Action { id: string; run_id: string; name: string; args: unknown; status: string; result: unknown; created_at: string }
interface View { chat: Chat; messages: Entry[]; hasOlder: boolean; actions: Action[]; run: { id: string; status: string; partialText: string; error: string | null; rounds: number } | null }
export interface ChatTarget { type: "agent" | "object"; id: string; name: string }
interface Profile { name: string; role: string; template: string; instructions: string; authority: string }
interface Ref { chatId: string; title: string; subject: { type: "owner" | "agent" | "object"; id: string }; updatedAt: string }
interface Index { profile?: Profile | null; chats: Chat[]; credentials: Credential[]; defaults: Config | null; refs?: Ref[] }
/** Messages the system chat relays to someone start with this; their chat shows it as the owner speaking through it. */
const RELAY = "[From the owner's system chat] ";
const number = (n = 0) => n.toLocaleString();
export const labels: Record<string, string> = { ask: "Ask", assign_to_ceo: "Hand to the CEO", objects: "Look at objects", directory: "Look up who and what", interact: "Interact", set_state: "Change state", look_around: "Look around", inspect: "Read world", patch_world: "Edit world", replace_world: "Replace world", patch_config: "Edit organization", create_task: "Create task", task_action: "Update task", spawn_agent: "Hire agent", update_agent: "Update agent", configure_agent: "Configure agent", prepare_self_runtime: "Set up task runtime", agent_action: "Control agent", retire_agent: "Retire agent", update_person: "Update member", grant_person: "Grant permission", revoke_permission: "Revoke permission", delegate_permission: "Delegate permission", credential_action: "Update API key", delete_asset: "Delete art" };

/** Server notices are written in English; show them in the interface's language. */
function noticeText(text: string) {
  const steps = text.match(/^Reached (\d+) steps for this reply\./);
  if (steps) return t("Reached {n} steps for this reply. Completed actions are saved; send a follow-up to continue.", { n: steps[1]! });
  return t(text);
}

/** Chat formatting: GitHub Markdown (tables, lists, code); model HTML and remote media never render. */
function ChatText({ text }: { text: string }) {
  return <div className="chat-message-text"><ReportText text={text} /></div>;
}

const actionStates: Record<string, string> = { applied: "Done", failed: "Couldn't complete", pending: "Needs confirmation", uncertain: "Check before retrying", rejected: "Skipped", applying: "Working", approved: "Approved" };
const dataObject = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const compactNumber = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k` : String(n);
const modelLabel = (model: string) => model.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2");

function ActionCard({ action: a, busy, decide, agents, tasks, credentials }: { credentials: Credential[]; action: Action; busy: boolean; decide: (id: string, approve: boolean) => unknown; agents: Array<{ id: string; displayName: string }>; tasks: Array<{ id: string; title: string }> }) {
  const args = dataObject(a.args), result = dataObject(a.result);
  const agent = agents.find(x => x.id === (args.assigneeAgentId ?? args.agentId ?? args.id))?.displayName;
  const task = tasks.find(x => x.id === args.id)?.title;
  const description = a.name === "assign_to_ceo" ? `${args.title ?? ""}${result.assignedTo ? ` · ${result.assignedTo.name}` : ""}` :
    a.name === "ask" ? `${agents.find(x => x.id === args.id)?.displayName ?? args.id}: ${String(args.message ?? "")}` :
    a.name === "create_task" ? `${args.title ?? t("New task")}${agent ? ` · ${agent}` : ""}` :
    a.name === "prepare_self_runtime" ? `${agent ?? t("This agent")} · ${credentials.find(k => k.id === args.credentialId)?.name ?? t("saved API connection")} · ${modelLabel(String(args.model))}${args.effort ? ` · ${args.effort}` : ""}${t(". Applies to task execution after your confirmation.")}` :
    a.name === "task_action" ? `${String(args.action ?? t("Update"))} · ${task ?? args.id ?? t("task")}` :
    a.name === "inspect" ? t("Checked {what}", { what: args.kind ?? t("world") }) : agent ?? (args.note || "");
  return <div className={`chat-action ${a.status}`}>
    <div className="chat-action-heading"><strong>{t(labels[a.name] ?? a.name)}</strong><span className="chat-action-state">{t(actionStates[a.status] ?? a.status)}</span></div>
    {description && <p className="chat-action-description">{description}</p>}
    {result.error && <p className="chat-action-error">{String(result.error)}</p>}
    {a.status === "pending" && <div className="chat-approval"><button type="button" className="primary" disabled={busy} onClick={() => decide(a.id, true)}>{t("Confirm")}</button><button type="button" disabled={busy} onClick={() => decide(a.id, false)}>{t("Skip")}</button></div>}
    <details className="chat-action-details"><summary>{t("Details")}</summary>
      <pre>{JSON.stringify(a.args, null, 2)}</pre>
      {a.result != null && <pre className="chat-result">{JSON.stringify(a.result, null, 2)}</pre>}
    </details>
  </div>;
}

/** Where a chat's selection is remembered, so another chat (a reference) can open it at that conversation. */
export const chatSelectionKey = (orgId: string, ownerId: string, subject?: { type: string; id: string } | null) => `owner-chat:${orgId}:${ownerId}${subject ? `:${subject.type}:${subject.id}` : ""}`;

export function OwnerChatDialog({ orgId, ownerId, orgName, subject, agents = [], tasks = [], onClose, onKeys, onOpenChat }: { agents?: Array<{ id: string; displayName: string }>; tasks?: Array<{ id: string; title: string }>; subject?: ChatTarget; orgId: string; ownerId: string; orgName: string; onClose: () => void; onKeys: () => void; onOpenChat?: (target: ChatTarget | null, chatId: string) => void }) {
  // Pin the path to this org. A switch elsewhere cannot redirect an in-flight write.
  const base = `/api/orgs/${encodeURIComponent(orgId)}/${subject ? `entity-chats/${subject.type}/${encodeURIComponent(subject.id)}` : "owner-chats"}`;
  const selectionKey = chatSelectionKey(orgId, ownerId, subject);
  const [index, setIndex] = useState<Index | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [settings, setSettings] = useState(false);
  const [archived, setArchived] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [older, setOlder] = useState<Entry[]>([]);
  const [historyExhausted, setHistoryExhausted] = useState(false);
  const [retry, setRetry] = useState<{ requestId: string; text: string; chatId: string } | null>(null);
  const [viewportHeight, setViewportHeight] = useState(window.visualViewport?.height);
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const selection = useRef<string | null>(null);
  // Starting from Archived changes the list filter asynchronously. Keep the
  // explicit new-chat choice and its settings when that list finishes loading.
  const pendingNew = useRef<{ config: Config | null } | null>(null);
  const active = !!view?.run && ["running", "waiting_approval"].includes(view.run.status);
  const readOnly = !!view?.chat.archivedAt || archived;
  const selectedKey = index?.credentials.find(k => k.id === config?.credentialId);
  const changed = view && config && Object.keys(config).some(k => config[k as keyof Config] !== view.chat.config[k as keyof Config]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => setViewportHeight(viewport?.height);
    viewport?.addEventListener("resize", resize);
    return () => viewport?.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    let disposed = false;
    api<Index>("GET", `${base}?archived=${archived}`).then(data => {
      if (disposed) return;
      setIndex(data);
      const pending = pendingNew.current; pendingNew.current = null;
      const saved = localStorage.getItem(selectionKey);
      const selected = pending ? undefined : data.chats.find(c => c.id === saved) ?? data.chats[0];
      selection.current = selected?.id ?? null;
      const nextConfig = pending?.config ?? selected?.config ?? data.defaults;
      setId(selection.current); setConfig(nextConfig);
      if (!nextConfig) setSettings(true);
    }).catch(e => !disposed && setError(e.message));
    return () => { disposed = true; };
  }, [base, selectionKey, archived]);

  // Poll durable snapshots while open: partial text streams into the run, reopening resumes it.
  useEffect(() => {
    if (!id) { setView(null); return; }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const data = await api<View>("GET", `${base}/${id}`);
        if (disposed || selection.current !== id) return;
        setView(previous => previous?.chat.id === data.chat.id ? { ...data, messages: [...new Map([...previous.messages, ...data.messages].map(m => [m.id, m])).values()].sort((a, b) => Number(a.id) - Number(b.id)) } : data);
        setIndex(i => i ? { ...i, chats: [data.chat, ...i.chats.filter(c => c.id !== data.chat.id)] } : i);
      } catch (e) {
        if (!disposed) setError((e as Error).message);
        if (e instanceof HttpError && [401, 403, 404].includes(e.status)) {
          setView(null); setIndex(null); setConfig(null); disposed = true; return;
        }
      }
      if (!disposed) timer = setTimeout(read, 900);
    };
    void read();
    return () => { disposed = true; clearTimeout(timer); };
  }, [base, id]);
  useEffect(() => {
    if (stick.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [view?.messages.length, view?.run?.partialText, view?.actions.length]);
  useEffect(() => { if (!settings && config && window.matchMedia("(min-width: 701px)").matches) composer.current?.focus(); }, [settings, !!config]);

  const choose = (next: string | null) => {
    if (busy) return;
    pendingNew.current = null;
    selection.current = next;
    setId(next); setView(null); setOlder([]); setHistoryExhausted(false); setError(""); setRetry(null); setDraft(""); setConfirmDelete(false); stick.current = true;
    setConfig(next ? index?.chats.find(c => c.id === next)?.config ?? index?.defaults ?? null : config ?? index?.defaults ?? null);
    if (next) localStorage.setItem(selectionKey, next); else localStorage.removeItem(selectionKey);
  };
  const execute = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, []);
  const refresh = async (chatId: string) => {
    const data = await api<View>("GET", `${base}/${chatId}`);
    if (selection.current === chatId) setView(data);
  };
  const ensureChat = async () => {
    if (!config) throw new Error("Add an API key in Manage → API keys first.");
    if (id) {
      if (changed) await api("PUT", `${base}/${id}/config`, config);
      return id;
    }
    const c = await api<Chat>("POST", base, config);
    selection.current = c.id; setId(c.id); localStorage.setItem(selectionKey, c.id);
    setIndex(i => i ? { ...i, chats: [c, ...i.chats] } : i);
    return c.id;
  };
  const send = () => execute(async () => {
    if (!draft.trim() || active || readOnly) return;
    const chatId = await ensureChat();
    const request = retry && retry.text === draft.trim() && retry.chatId === chatId ? retry : { requestId: requestId(), text: draft.trim(), chatId };
    setRetry(request);
    await api("POST", `${base}/${chatId}/messages`, { requestId: request.requestId, text: request.text });
    setDraft(""); setRetry(null); setSettings(false); stick.current = true; await refresh(chatId);
  });
  const more = () => execute(async () => {
    const first = older[0] ?? view?.messages[0];
    if (!id || !first) return;
    const data = await api<View>("GET", `${base}/${id}?before=${first.id}`);
    setOlder(x => [...data.messages, ...x]);
    if (!data.hasOlder) setHistoryExhausted(true);
  });
  const decide = (actionId: string, approve: boolean) => execute(async () => {
    await api("POST", `${base}/${id}/actions/${actionId}`, { approve }); await refresh(id!);
  });
  const saveSettings = () => execute(async () => {
    const next = await ensureChat(); await refresh(next); setSettings(false);
  });
  const compact = () => execute(async () => {
    await api("POST", `${base}/${id}/compact`, { requestId: requestId() }); await refresh(id!);
  });
  const lifecycle = (action: "archive" | "restore" | "delete") => execute(async () => {
    if (!id || active) return;
    if (action === "delete") await api("DELETE", `${base}/${id}`);
    else await api("PUT", `${base}/${id}/archive`, { archived: action === "archive" });
    if (action === "restore") {
      localStorage.setItem(selectionKey, id); setConfirmDelete(false); setIndex(null); setArchived(false); return;
    }
    selection.current = null; setId(null); setView(null); setOlder([]); setHistoryExhausted(false);
    setRetry(null); setDraft(""); setConfirmDelete(false); localStorage.removeItem(selectionKey);
    const data = await api<Index>("GET", `${base}?archived=${archived}`);
    setIndex(data); setConfig(config ?? data.defaults);
  });
  const switchArchive = () => { choose(null); setIndex(null); setArchived(a => !a); setSettings(false); };
  const newChat = () => {
    if (busy) return;
    choose(null);
    if (archived || !index) pendingNew.current = { config: config ?? index?.defaults ?? null };
    if (archived) { setIndex(null); setArchived(false); }
  };
  const messages = [...new Map([...older, ...(view?.messages ?? [])].map(m => [m.id, m])).values()].sort((a, b) => Number(a.id) - Number(b.id));
  const activity = new Map<string, Action[]>();
  for (const action of view?.actions ?? []) if (!["pending", "uncertain"].includes(action.status)) activity.set(action.run_id, [...(activity.get(action.run_id) ?? []), action]);
  const timeline = [
    ...messages.map(item => ({ kind: "message" as const, item, at: item.created_at })),
    ...(view?.actions ?? []).filter(a => ["pending", "uncertain"].includes(a.status)).map(item => ({ kind: "action" as const, item, at: item.created_at })),
    ...[...activity].map(([runId, items]) => ({ kind: "activity" as const, runId, items, at: items.at(-1)!.created_at })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const contextBudget = Math.min(config?.contextLimit ?? 64000, view?.chat.modelInfo?.contextWindow ?? Infinity);
  const context = view?.chat.contextTokens ?? 0;
  const usage = view?.chat.usage;
  const assistantName = index?.profile?.name ?? (subject?.name || (subject ? "" : t("System chat")));
  const actionable = view?.actions.filter(a => a.status === "pending") ?? [];
  const self: Who = subject ? { type: subject.type, id: subject.id } : { type: "system" };
  const whoOf = (m: Entry): Who => m.role === "user" ? { type: "you" } : m.author_type && m.author_id ? { type: m.author_type, id: m.author_id } : self;
  const nameOf = (m: Entry) => m.author_type && m.author_id ? <WhoName who={{ type: m.author_type, id: m.author_id }} /> : assistantName;
  const refWho = (r: Ref): Who => r.subject.type === "owner" ? { type: "system" } : { type: r.subject.type, id: r.subject.id };
  return <Modal title={subject ? t("Chat · {name}", { name: assistantName }) : t("System chat · {org}", { org: orgName })} onClose={onClose} wide className="owner-chat-modal" style={{ "--chat-viewport-height": viewportHeight ? `${viewportHeight}px` : "100dvh" } as CSSProperties}>
    <div className="owner-chat-shell">
      <div className="owner-chat-toolbar">
        <select aria-label={t("Conversation")} value={id ?? ""} disabled={busy} onChange={e => choose(e.target.value || null)}>
          <option value="">{archived ? t("Select archived chat") : t("New conversation")}</option>
          {index?.chats.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
        <button type="button" onClick={newChat} disabled={busy} title={t("Start a separate conversation with the current settings")}>＋ {t("New")}</button>
        <Menu trigger="•••" label={t("Chat options")} items={[
          { label: settings ? t("Back to chat") : t("Settings"), onSelect: () => setSettings(x => !x) },
          ...(!busy ? [{ label: archived ? t("Active conversations") : t("Archived conversations"), onSelect: switchArchive }] : []),
          ...(id && !busy && !active ? [
            { label: readOnly ? t("Restore conversation") : t("Archive conversation"), onSelect: () => { void lifecycle(readOnly ? "restore" : "archive"); } },
            { label: t("Delete conversation…"), onSelect: () => setConfirmDelete(true), danger: true },
          ] : []),
        ]} />
      </div>
      {!!index?.refs?.length && onOpenChat && <details className="chat-refs">
        <summary>{t("Mentioned in {n} other conversations", { n: index.refs.length })}</summary>
        <div>{index.refs.map(r => <button type="button" key={r.chatId} className="chat-ref" onClick={() => onOpenChat(r.subject.type === "owner" ? null : { type: r.subject.type, id: r.subject.id, name: "" }, r.chatId)}>
          <Avatar who={refWho(r)} size={20} />
          <span className="chat-ref-title"><b><WhoName who={refWho(r)} /></b> · {r.title}</span>
        </button>)}</div>
      </details>}
      {archived && <div className="chat-archive-banner">{t("Archived conversations")}<button type="button" disabled={busy} onClick={switchArchive}>{t("Back to chat")}</button></div>}
      {confirmDelete && <div className="chat-delete-confirm" role="alert">
        <p>{t("Delete “{title}” permanently? This removes its messages and action receipts. Changes already made in the world remain.", { title: view?.chat.title ?? index?.chats.find(c => c.id === id)?.title ?? "" })}</p>
        <div><button type="button" className="danger" disabled={busy || active} onClick={() => lifecycle("delete")}>{t("Delete permanently")}</button><button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>{t("Cancel")}</button></div>
      </div>}
      {settings && <div className="owner-chat-settings">
        {!index?.credentials.length ? <div className="empty"><p>{t("This chat needs an available API key in its world.")}</p><button type="button" onClick={onKeys}>{t("Open API keys")}</button></div> : config && <>
          <div className="chat-settings-grid">
            <label>{t("API key")}<select value={config.credentialId} disabled={active || busy || readOnly} onChange={e => {
              const k = index.credentials.find(x => x.id === e.target.value)!;
              setConfig({ ...config, credentialId: k.id, model: k.models[0]!, effort: "medium" });
            }}>{index.credentials.map(k => <option key={k.id} value={k.id}>{k.name} · {k.provider}</option>)}</select></label>
            <label>{t("Model")}<select value={config.model} disabled={active || busy || readOnly} onChange={e => setConfig({ ...config, model: e.target.value })}>
              {selectedKey?.models.map(m => <option key={m}>{m}</option>)}
            </select></label>
            <label>{t("Effort")}<select value={config.effort ?? ""} disabled={active || busy || readOnly} onChange={e => setConfig({ ...config, effort: e.target.value || null })}>
              <option value="">{t("Provider default")}</option>{["low", "medium", "high", "xhigh", "max"].map(v => <option key={v}>{v}</option>)}
            </select></label>
          </div>
          <details className="chat-advanced-settings"><summary>{t("Limits & confirmations")}</summary><div className="chat-settings-grid">
            <label>{t("Confirm changes")}<select value={config.approvalMode} disabled={active || busy || readOnly} onChange={e => setConfig({ ...config, approvalMode: e.target.value as Config["approvalMode"] })}>
              <option value="important">{t("Important actions")}</option><option value="all">{t("Every change")}</option>
            </select></label>
            <label>{t("Context budget")}<input type="number" min={8192} max={1000000} step={1024} value={config.contextLimit} disabled={active || busy || readOnly} onChange={e => setConfig({ ...config, contextLimit: Number(e.target.value) })} /></label>
            <label>{t("Output limit")}<input type="number" min={256} max={32000} step={256} value={config.maxOutputTokens} disabled={active || busy || readOnly} onChange={e => setConfig({ ...config, maxOutputTokens: Number(e.target.value) })} /></label>
            <label>{t("Steps per reply")}<input type="number" min={1} max={40} value={config.maxTurns} disabled={active || busy || readOnly} onChange={e => setConfig({ ...config, maxTurns: Number(e.target.value) })} /></label>
          </div></details>
        {index?.profile && <details className="entity-chat-instructions">
          <summary>{t("Persona instructions")} · {index.profile.role}</summary>
          <p className="muted">{index.profile.authority}</p>
          <label>{t("Default instructions")}<textarea readOnly rows={4} value={index.profile.template} /></label>
          {index.profile.instructions && <label>{t("Custom instructions")}<textarea readOnly rows={4} value={index.profile.instructions} /></label>}
          <p className="muted small">{subject?.type === "agent" ? t("Edit custom instructions in this agent’s Config tab.") : t("Edit instructions for this object or its kind in the world editor.")} {t("The persona can create useful follow-up tasks; important changes require confirmation.")}</p>
        </details>}

          <p className="muted">{t("New conversations keep these settings. Changes here apply to this chat, independently of the agent’s runtime.")}</p>
          <button type="button" className="primary" disabled={active || busy || readOnly} onClick={saveSettings}>{t("Save settings")}</button>
        </>}
      </div>}
      <details className="owner-chat-context">
        <summary><span>{t("Context")} {compactNumber(context)} / {compactNumber(contextBudget)}</span><span className="muted">{view?.chat.countMode === "api" ? "" : "≈ "}{t("Auto compact")} <span aria-hidden>⌄</span></span></summary>
        <progress max={contextBudget} value={Math.min(context, contextBudget)} aria-label={t("Context usage")} />
        <div className="chat-usage muted">{t("Input {i} · Output {o} · Cached {c}", { i: number(usage?.inputTokens), o: number(usage?.outputTokens), c: number(usage?.cachedTokens) })}{usage?.compactions ? t(" · {n} compacts", { n: usage.compactions }) : ""}
          {id && <button type="button" disabled={active || busy || readOnly || !messages.length} onClick={compact}>{t("Compact now")}</button>}
        </div>
        <p className="muted">{view?.chat.countMode === "api" ? t("Counted by the provider.") : t("Estimated context size.")} {t("Compacts automatically at 75% of the input budget. History stays available.")}</p>
        {!!usage?.incompleteRequests && <small className="muted">{t("Usage totals are incomplete for {n} interrupted or unreported request(s).", { n: usage.incompleteRequests })}</small>}
      </details>
      <div className="owner-chat-history" ref={scroll} onScroll={() => {
        const s = scroll.current!; stick.current = s.scrollHeight - s.scrollTop - s.clientHeight < 90;
      }} aria-label={t("Chat history")}>
        {view?.hasOlder && !historyExhausted && <button type="button" className="chat-older" disabled={busy} onClick={more}>{t("Load earlier messages")}</button>}
        {readOnly && <p className="chat-archive-notice muted">{id ? t("This chat is archived. Restore it to continue.") : t("Select an archived chat above, or start a new conversation.")}</p>}
        {!messages.length && !active && !readOnly && <div className="chat-welcome">
          <h3>{subject ? t("Talk with {name}", { name: assistantName }) : t("Your world, one conversation")}</h3>
          <p>{subject ? t("Ask a question or think something through together. Tasks are created when there is work to do.") : t("Ask about your team, or tell me what you want to change.")}</p>
          <div className="chat-suggestions">{(subject ? ["Bạn có thể giúp tôi những gì?", "Cùng phân tích tình trạng hiện tại"] : ["Tóm tắt tình trạng hiện tại", "Ai đang cần tôi xử lý?"]).map(text => <button type="button" key={text} onClick={() => { setDraft(text); composer.current?.focus(); }}>{text}</button>)}</div>
          <small className="muted">{subject ? t("Private to you · Important changes need confirmation.") : t("Private to you · I read everything but change nothing myself: I ask the right person, or hand work to the CEO once you confirm.")}</small>
        </div>}
        {timeline.map(row => row.kind === "action" ? <ActionCard key={row.item.id} action={row.item} busy={busy} decide={decide} agents={agents} tasks={tasks} credentials={index?.credentials ?? []} /> : row.kind === "activity" ? <details className="chat-activity" key={row.runId}>
          <summary>{row.items.length} {row.items.length === 1 ? t("step") : t("steps")}{row.items.some(a => a.status === "failed") ? t(" · {n} couldn't complete", { n: row.items.filter(a => a.status === "failed").length }) : t(" completed")}</summary>
          <div>{row.items.map(a => <ActionCard key={a.id} action={a} busy={busy} decide={decide} agents={agents} tasks={tasks} credentials={index?.credentials ?? []} />)}</div>
        </details> : row.item.role === "notice" ? <article key={row.item.id} className="chat-message chat-notice"><ChatText text={noticeText(row.item.text)} /></article> : <article key={row.item.id} className={`chat-message chat-${row.item.role}${row.item.author_type ? " chat-relayed" : ""}`}>
          <Avatar who={whoOf(row.item)} size={30} className="chat-avatar" />
          <div className="chat-bubble">
            <div className="chat-message-label">{row.item.role === "user" ? t("You") : nameOf(row.item)}{row.item.role === "user" && row.item.text.startsWith(RELAY) && <span className="muted"> · {t("via the system chat")}</span>}{row.item.partial && <span className="muted"> · {t("partial response")}</span>}</div>
            <ChatText text={row.item.role === "user" && row.item.text.startsWith(RELAY) ? row.item.text.slice(RELAY.length) : row.item.text} />
          </div>
        </article>)}
        {view?.run?.partialText && <article className="chat-message chat-assistant"><Avatar who={self} size={30} className="chat-avatar" /><div className="chat-bubble"><div className="chat-message-label">{assistantName} · {t("writing")}</div><ChatText text={view.run.partialText} /></div></article>}
        {active && <div className="chat-working" role="status">{actionable.length ? t("Waiting for your confirmation above") : t("Working · step {n} of {max}", { n: view?.run?.rounds ?? 0, max: config?.maxTurns ?? 5 })}</div>}
        {view?.run?.error && <div className="chat-error" role="status">{view.run.error}</div>}
      </div>
      {error && <div className="chat-error" role="alert">{error}</div>}
      <form className="owner-chat-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
        <textarea ref={composer} aria-label={t("Message {name}", { name: assistantName })} placeholder={!index ? t("Loading…") : readOnly ? t("Restore this chat to continue…") : config ? subject ? t("Ask {name} or discuss an idea…", { name: assistantName }) : t("Ask or give an instruction for this world…") : t("Add an API key to start…")} value={draft} rows={2} maxLength={50000} disabled={!config || readOnly} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(min-width: 701px)").matches) { e.preventDefault(); if (!busy && !active) void send(); } }} />
        <div className="chat-send-row"><small className="muted">{config ? modelLabel(config.model) : index ? t("Choose a model") : ""}{config?.effort ? ` · ${config.effort}` : ""}</small>
          {active ? <button type="button" disabled={busy} onClick={() => execute(async () => { await api("POST", `${base}/${id}/stop`); await refresh(id!); })}>{t("Stop")}</button> : <button type="submit" className="primary" disabled={busy || readOnly || !draft.trim() || !config}>{busy ? t("Sending…") : `${t("Send")} ↑`}</button>}
        </div>
      </form>
    </div>
  </Modal>;
}
