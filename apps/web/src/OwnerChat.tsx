import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { api, HttpError } from "./api.ts";
import { Modal, StatusPill } from "./ui.tsx";
import { requestId } from "./requestId.ts";

interface Config { credentialId: string; model: string; effort: string | null; contextLimit: number; maxOutputTokens: number; maxTurns: number; approvalMode: "important" | "all" }
interface Chat { id: string; title: string; archivedAt: string | null; config: Config; contextTokens: number; countMode: string; modelInfo: { contextWindow: number | null; nativeCompaction: boolean; efforts: string[] | null } | null; usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; compactions?: number; incompleteRequests?: number } }
interface Credential { id: string; name: string; provider: string; models: string[] }
interface Entry { id: string; role: string; text: string; partial: boolean; run_id: string; created_at: string }
interface Action { id: string; run_id: string; name: string; args: unknown; status: string; result: unknown; created_at: string }
interface View { chat: Chat; messages: Entry[]; hasOlder: boolean; actions: Action[]; run: { id: string; status: string; partialText: string; error: string | null; rounds: number } | null }
export interface ChatTarget { type: "agent" | "object"; id: string; name: string }
interface Profile { name: string; role: string; template: string; instructions: string; authority: string }
interface Index { profile?: Profile | null; chats: Chat[]; credentials: Credential[]; defaults: Config | null }
const number = (n = 0) => n.toLocaleString();
const labels: Record<string, string> = { inspect: "Read world", patch_world: "Edit world", replace_world: "Replace world", patch_config: "Edit organization", create_task: "Create task", task_action: "Update task", spawn_agent: "Hire agent", update_agent: "Update agent", configure_agent: "Configure agent", agent_action: "Control agent", retire_agent: "Retire agent", update_person: "Update member", grant_person: "Grant permission", revoke_permission: "Revoke permission", delegate_permission: "Delegate permission", credential_action: "Update API key", delete_asset: "Delete art" };

/** Small, safe chat formatting. Text stays escaped; model HTML and remote media never render. */
function ChatText({ text }: { text: string }) {
  return <div className="chat-message-text">{text.split(/(```[\s\S]*?```|`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, n) =>
    part.startsWith("```") && part.endsWith("```") && part.length >= 6 ? <pre className="chat-code" key={n}><code>{part.slice(3, -3).replace(/^[a-zA-Z0-9_-]*\n/, "")}</code></pre> :
    part.startsWith("`") && part.endsWith("`") && part.length > 1 ? <code key={n}>{part.slice(1, -1)}</code> :
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong key={n}>{part.slice(2, -2)}</strong> : part)}</div>;
}

function ActionCard({ action: a, busy, decide }: { action: Action; busy: boolean; decide: (id: string, approve: boolean) => unknown }) {
  return <div className="chat-actions"><details className={`chat-action ${a.status}`} open={a.status === "pending" || a.status === "uncertain"}>
    <summary><span>{labels[a.name] ?? a.name}</span><StatusPill state={a.status} /></summary>
    <pre>{JSON.stringify(a.args, null, 2)}</pre>
    {a.result != null && <pre className="chat-result">{JSON.stringify(a.result, null, 2)}</pre>}
    {a.status === "pending" && <div className="chat-approval"><button type="button" className="primary" disabled={busy} onClick={() => decide(a.id, true)}>Approve action</button><button type="button" disabled={busy} onClick={() => decide(a.id, false)}>Reject</button></div>}
  </details></div>;
}

export function OwnerChatDialog({ orgId, ownerId, orgName, subject, onClose, onKeys }: { subject?: ChatTarget; orgId: string; ownerId: string; orgName: string; onClose: () => void; onKeys: () => void }) {
  // Pin the path to this org. A switch elsewhere cannot redirect an in-flight write.
  const base = `/api/orgs/${encodeURIComponent(orgId)}/${subject ? `entity-chats/${subject.type}/${encodeURIComponent(subject.id)}` : "owner-chats"}`;
  const selectionKey = `owner-chat:${orgId}:${ownerId}${subject ? `:${subject.type}:${subject.id}` : ""}`;
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
      const saved = localStorage.getItem(selectionKey);
      const selected = data.chats.find(c => c.id === saved) ?? data.chats[0];
      selection.current = selected?.id ?? null;
      setId(selection.current); setConfig(selected?.config ?? data.defaults);
      if (!data.defaults) setSettings(true);
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
    selection.current = next;
    setId(next); setView(null); setOlder([]); setHistoryExhausted(false); setError(""); setRetry(null); setDraft(""); setConfirmDelete(false); stick.current = true;
    setConfig(index?.chats.find(c => c.id === next)?.config ?? index?.defaults ?? null);
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
    setIndex(data); setConfig(data.defaults);
  });
  const switchArchive = () => { choose(null); setIndex(null); setArchived(a => !a); setSettings(false); };
  const newChat = () => { choose(null); if (archived) { setIndex(null); setArchived(false); } };
  const messages = [...new Map([...older, ...(view?.messages ?? [])].map(m => [m.id, m])).values()].sort((a, b) => Number(a.id) - Number(b.id));
  const timeline = [
    ...messages.map(item => ({ kind: "message" as const, item, at: item.created_at })),
    ...(view?.actions ?? []).map(item => ({ kind: "action" as const, item, at: item.created_at })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const contextBudget = Math.min(config?.contextLimit ?? 64000, view?.chat.modelInfo?.contextWindow ?? Infinity);
  const context = view?.chat.contextTokens ?? 0;
  const usage = view?.chat.usage;
  const assistantName = index?.profile?.name ?? subject?.name ?? "Owner assistant";
  const actionable = view?.actions.filter(a => a.status === "pending") ?? [];
  return <Modal title={subject ? `Chat · ${assistantName}` : `Owner chat · ${orgName}`} onClose={onClose} wide className="owner-chat-modal" style={{ "--chat-viewport-height": viewportHeight ? `${viewportHeight}px` : "100dvh" } as CSSProperties}>
    <div className="owner-chat-shell">
      <div className="owner-chat-toolbar">
        <select aria-label="Conversation" value={id ?? ""} disabled={busy} onChange={e => choose(e.target.value || null)}>
          <option value="">{archived ? "Select archived chat" : "New conversation"}</option>
          {index?.chats.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
        <button type="button" onClick={newChat} disabled={busy} title="Start a separate conversation">＋ New</button>
        <button type="button" onClick={() => setSettings(s => !s)} aria-expanded={settings}>Settings</button>
      </div>
      <div className="owner-chat-management">
        <button type="button" disabled={busy} aria-pressed={archived} onClick={switchArchive}>{archived ? "← Active chats" : "Archived chats"}</button>
        {id && <>
          <button type="button" disabled={busy || active} onClick={() => lifecycle(readOnly ? "restore" : "archive")}>{readOnly ? "Restore" : "Archive"}</button>
          <button type="button" disabled={busy || active} aria-expanded={confirmDelete} onClick={() => setConfirmDelete(c => !c)}>Delete</button>
        </>}
      </div>
      {confirmDelete && <div className="chat-delete-confirm" role="alert">
        <p>Delete “{view?.chat.title ?? index?.chats.find(c => c.id === id)?.title}” permanently? This removes its messages and action receipts. Changes already made in the world remain.</p>
        <div><button type="button" className="danger" disabled={busy || active} onClick={() => lifecycle("delete")}>Delete permanently</button><button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</button></div>
      </div>}
      {settings && <div className="owner-chat-settings">
        {index?.profile && <details className="entity-chat-instructions" open>
          <summary>Persona instructions · {index.profile.role}</summary>
          <p className="muted">{index.profile.authority}</p>
          <label>Default instructions<textarea readOnly rows={4} value={index.profile.template} /></label>
          {index.profile.instructions && <label>Custom instructions<textarea readOnly rows={4} value={index.profile.instructions} /></label>}
          <p className="muted small">{subject?.type === "agent" ? "Edit custom instructions in this agent’s Config tab." : "Edit instructions for this object or its kind in the world editor."} The persona can create useful follow-up tasks; important changes require confirmation.</p>
        </details>}

        {!index?.credentials.length ? <div className="empty"><p>This chat needs an available API key in its world.</p><button type="button" onClick={onKeys}>Open API keys</button></div> : config && <>
          <div className="chat-settings-grid">
            <label>API key<select value={config.credentialId} disabled={active || busy || readOnly} onChange={e => {
              const k = index.credentials.find(x => x.id === e.target.value)!;
              setConfig({ ...config, credentialId: k.id, model: k.models[0]!, effort: "medium" });
            }}>{index.credentials.map(k => <option key={k.id} value={k.id}>{k.name} · {k.provider}</option>)}</select></label>
            <label>Model<select value={config.model} disabled={active || busy || readOnly} onChange={e => setConfig({ ...config, model: e.target.value })}>
              {selectedKey?.models.map(m => <option key={m}>{m}</option>)}
            </select></label>
            <label>Effort<select value={config.effort ?? ""} disabled={active || busy || readOnly} onChange={e => setConfig({ ...config, effort: e.target.value || null })}>
              <option value="">Provider default</option>{["low", "medium", "high", "xhigh", "max"].map(v => <option key={v}>{v}</option>)}
            </select></label>
            <label>Confirm changes<select value={config.approvalMode} disabled={active || busy || readOnly} onChange={e => setConfig({ ...config, approvalMode: e.target.value as Config["approvalMode"] })}>
              <option value="important">Important actions</option><option value="all">Every change</option>
            </select></label>
            <label>Context budget<input type="number" min={8192} max={1000000} step={1024} value={config.contextLimit} disabled={active || busy || readOnly} onChange={e => setConfig({ ...config, contextLimit: Number(e.target.value) })} /></label>
            <label>Output limit<input type="number" min={256} max={32000} step={256} value={config.maxOutputTokens} disabled={active || busy || readOnly} onChange={e => setConfig({ ...config, maxOutputTokens: Number(e.target.value) })} /></label>
            <label>Tool turn limit<input type="number" min={1} max={40} value={config.maxTurns} disabled={active || busy || readOnly} onChange={e => setConfig({ ...config, maxTurns: Number(e.target.value) })} /></label>
          </div>
          <p className="muted">Uses this world's saved key. Chat settings are independent of agent settings. Effort applies when supported by the provider and model.</p>
          <button type="button" className="primary" disabled={active || busy || readOnly} onClick={saveSettings}>Save settings</button>
        </>}
      </div>}
      <div className="owner-chat-context" title="Input includes chat history, system instructions and tool definitions. Auto compact starts at 75% of the input budget after reserving output tokens.">
        <div><b>{number(context)} / {number(contextBudget)}</b> context · {view?.chat.countMode === "api" ? "API count" : "estimated"}<span className="muted"> · Auto compact</span></div>
        <progress max={contextBudget} value={Math.min(context, contextBudget)} aria-label="Context usage" />
        <div className="chat-usage muted">Input {number(usage?.inputTokens)} · Output {number(usage?.outputTokens)} · Cached {number(usage?.cachedTokens)}{usage?.compactions ? ` · ${usage.compactions} compacts` : ""}
          {id && <button type="button" disabled={active || busy || readOnly || !messages.length} onClick={compact}>Compact now</button>}
        </div>
        {!!usage?.incompleteRequests && <small className="muted">Usage totals are incomplete for {usage.incompleteRequests} interrupted or unreported request(s).</small>}
      </div>
      <div className="owner-chat-history" ref={scroll} onScroll={() => {
        const s = scroll.current!; stick.current = s.scrollHeight - s.scrollTop - s.clientHeight < 90;
      }} aria-label="Chat history">
        {view?.hasOlder && !historyExhausted && <button type="button" className="chat-older" disabled={busy} onClick={more}>Load earlier messages</button>}
        {readOnly && <p className="chat-archive-notice muted">{id ? "This chat is archived. Restore it to continue." : "Select an archived chat above, or start a new conversation."}</p>}
        {!messages.length && !active && !readOnly && <div className="chat-welcome">
          <div className="chat-mark" aria-hidden>✦</div><h3>{subject ? `Talk with ${assistantName}` : "Manage your world in one conversation"}</h3>
          <p>{subject ? "Ask questions, explore ideas and analyze together. Useful follow-up work can become a task; important actions wait for your confirmation." : "Ask about agents, tasks and the office. Make changes here; important actions wait for your confirmation."}</p>
          <div className="chat-suggestions">{(subject ? ["Bạn có thể giúp tôi những gì?", "Cùng phân tích tình trạng world hiện tại", "Có việc nào nên tạo task để theo dõi không?"] : ["Tóm tắt tình trạng world hiện tại", "Agent nào đang cần tôi xử lý?", "Tôi có thể thay đổi layout world thế nào?"]).map(text => <button type="button" key={text} onClick={() => { setDraft(text); composer.current?.focus(); }}>{text}</button>)}</div>
          <small className="muted">Private to you in {orgName}. {subject ? "Conversation is separate from task execution." : "No task is created unless you ask."}</small>
        </div>}
        {timeline.map(row => row.kind === "action" ? <ActionCard key={row.item.id} action={row.item} busy={busy} decide={decide} /> : <article key={row.item.id} className={`chat-message chat-${row.item.role}`}>
          <div className="chat-message-label">{row.item.role === "user" ? "You" : row.item.role === "notice" ? "Context" : assistantName}{row.item.partial && <span className="muted"> · partial response</span>}</div>
          <ChatText text={row.item.text} />
        </article>)}
        {view?.run?.partialText && <article className="chat-message chat-assistant"><div className="chat-message-label">{assistantName} · writing</div><ChatText text={view.run.partialText} /></article>}
        {active && <div className="chat-working" role="status">{actionable.length ? "Waiting for your confirmation above" : "Working in this world…"}</div>}
        {view?.run?.error && <div className="chat-error" role="status">{view.run.error}</div>}
      </div>
      {error && <div className="chat-error" role="alert">{error}</div>}
      <form className="owner-chat-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
        <textarea ref={composer} aria-label={`Message ${assistantName}`} placeholder={readOnly ? "Restore this chat to continue…" : config ? subject ? `Ask ${assistantName} or discuss an idea…` : "Ask or give an instruction for this world…" : "Add an API key to start…"} value={draft} rows={2} maxLength={50000} disabled={!config || readOnly} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(min-width: 701px)").matches) { e.preventDefault(); if (!busy && !active) void send(); } }} />
        <div className="chat-send-row"><small className="muted">{config?.model ?? "No API key"}{config?.effort ? ` · ${config.effort}` : ""}<br />{active ? "Closing this window keeps the response available." : "Only this world's owner can use this chat."}</small>
          {active ? <button type="button" disabled={busy} onClick={() => execute(async () => { await api("POST", `${base}/${id}/stop`); await refresh(id!); })}>Stop</button> : <button type="submit" className="primary" disabled={busy || readOnly || !draft.trim() || !config}>{busy ? "Sending…" : "Send ↑"}</button>}
        </div>
      </form>
    </div>
  </Modal>;
}
