import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import type { AgentDetail, Catalog, Credential, Effort } from "./types.ts";
import { Modal, ago } from "./ui.tsx";

type Notify = (msg: string, kind?: "error" | "info") => void;
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Owner-only key manager. Saved key values and fragments are never returned. */
export function CredentialsDialog({ catalog, onClose, notify, now }: { catalog: Catalog | null; onClose: () => void; notify: Notify; now: number }) {
  const [rows, setRows] = useState<Credential[] | null>(null);
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [provider, setProvider] = useState("anthropic");
  const [baseUrl, setBaseUrl] = useState("");
  const [protocol, setProtocol] = useState<"anthropic" | "openai">("openai");
  const [authMode, setAuthMode] = useState("bearer");
  const [headerName, setHeaderName] = useState("");
  const [headerScheme, setHeaderScheme] = useState<"raw" | "bearer">("raw");
  const [departments, setDepartments] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Credential | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const providers = catalog?.providers ?? [{ id: "anthropic", label: "Anthropic (Claude)", baseUrl: null, keyRequired: true, keyPlaceholder: "sk-ant-…" }];
  const info = providers.find((p) => p.id === provider) ?? providers[0]!;
  const usesClaude = provider === "anthropic" || (provider === "custom" && protocol === "anthropic");
  const load = useCallback(() => api<{ credentials: Credential[] }>("GET", "/api/credentials").then((r) => setRows(r.credentials)), []);
  useEffect(() => void load().catch((e) => notify(e.message, "error")), [load]);
  useEffect(() => { if (editing) form.current?.scrollIntoView({ block: "start", behavior: "smooth" }); }, [editing?.id]);
  const edit = (c: Credential) => {
    setEditing(c); setProvider("custom"); setProtocol(c.protocol); setBaseUrl(c.baseUrl ?? ""); setWorkspaceId(c.workspaceId ?? ""); setApiKey("");
    setAuthMode(c.authHeader.name === "x-api-key" && c.authHeader.scheme === "raw" ? "x-api-key" : c.authHeader.name === "authorization" && c.authHeader.scheme === "bearer" ? "bearer" : "custom");
    setHeaderName(c.authHeader.name); setHeaderScheme(c.authHeader.scheme);
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editing && !confirm(`Update connection for "${editing.name}"? Its saved API key will be sent to ${baseUrl.trim()} using the selected protocol and header. Model requests use the updated settings immediately; changing protocol may interrupt an active task.`)) return;
    setBusy(true);
    try {
      const connection = { workspaceId: usesClaude ? workspaceId.trim() || null : null, baseUrl: baseUrl.trim(), protocol,
        authHeader: authMode === "custom" ? { name: headerName.trim(), scheme: headerScheme } : authMode === "x-api-key" ? { name: "x-api-key", scheme: "raw" } : { name: "authorization", scheme: "bearer" } };
      const c = editing ? await api<Credential>("PUT", `/api/credentials/${editing.id}/connection`, { ...connection, revision: editing.revision }) : await api<Credential>("POST", "/api/credentials", {
        name,
        provider,
        apiKey: apiKey || null,
        workspaceId: usesClaude ? workspaceId.trim() || null : null,
        baseUrl: provider === "custom" ? baseUrl.trim() : null,
        ...(provider === "custom" ? connection : {}),
        departments: departments.length ? departments : null,
      });
      notify(`Key "${c.name}" saved — ${c.models.length} models available`, "info");
      setName("");
      setApiKey("");
      setWorkspaceId("");
      setBaseUrl("");
      setDepartments([]);
      setEditing(null);
      await load();
    } catch (err) {
      notify((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const refresh = async (id: string) => {
    try {
      await api("POST", `/api/credentials/${id}/refresh-models`);
      await load();
    } catch (err) {
      notify((err as Error).message, "error");
    }
  };
  const revoke = async (c: Credential) => {
    if (!confirm(`Revoke "${c.name}"? Agents using it lose the key (idle runtimes are replaced right away).`)) return;
    await api("DELETE", `/api/credentials/${c.id}`).catch((err) => notify(err.message, "error"));
    await load();
  };

  return (
    <Modal title="API keys" onClose={onClose} wide>
      <p className="muted small">
        Saved API keys are hidden from owners and agents. Keys stay encrypted on the server; agent runtimes receive model access through the server, without receiving the key.
      </p>
      <div className="table-wrap">
        <table className="grid mobile-cards">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Departments</th>
              <th>Models</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((c) => (
              <tr key={c.id} className={c.revokedAt ? "muted" : ""}>
                <td>
                  <strong>{c.name}</strong>
                  <div className="muted small">
                    {providers.find((p) => p.id === c.provider)?.label ?? c.provider}
                    {c.provider === "custom" && c.baseUrl ? ` (${c.baseUrl})` : ""} · {c.revokedAt ? `revoked ${ago(c.revokedAt, now)}` : `added ${ago(c.createdAt, now)}`}
                    {c.provider === "custom" && <div>{c.protocol === "anthropic" ? "Anthropic / Claude" : "OpenAI-compatible"} · {c.authHeader.name}{c.authHeader.scheme === "bearer" ? " (Bearer)" : " (raw key)"}</div>}
                  </div>
                </td>
                <td data-label="Key">
                  <code>{c.keyHint}</code>
                  {c.workspaceId && <div className="muted small">{c.workspaceId}</div>}
                </td>
                <td data-label="Departments" className="small">{c.departments?.join(", ") ?? "all"}</td>
                <td data-label="Models" className="small mobile-wide">{c.models.join(", ")}</td>
                <td>
                  {!c.revokedAt && (
                    <div className="btn-row">
                      {c.provider === "custom" && <button type="button" disabled={busy} onClick={() => edit(c)}>Edit connection</button>}
                      <button type="button" onClick={() => refresh(c.id)}>
                        Refresh models
                      </button>
                      <button type="button" className="danger" onClick={() => revoke(c)}>
                        Revoke
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {rows?.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No keys yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <form ref={form} className="form" onSubmit={add} style={{ marginTop: 16 }}>
        <h3>{editing ? `Edit connection · ${editing.name}` : "Add a key"}</h3>
        {editing ? <p className="muted small">Uses the saved API key. Models are checked again before saving; the key stays encrypted and existing agent assignments are retained.</p> : <>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Engineering team key" required maxLength={60} />
        </label>
        <label>
          Provider
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        </>}
        {provider === "custom" && (<>
          <label>API protocol<select value={protocol} onChange={e => {
            const next = e.target.value as "anthropic" | "openai"; setProtocol(next); setAuthMode(next === "anthropic" ? "x-api-key" : "bearer");
          }}><option value="openai">OpenAI-compatible · /chat/completions</option><option value="anthropic">Anthropic / Claude · /v1/messages</option></select></label>
          <label>
            {usesClaude ? "Base URL (gateway root or URL ending in /v1)" : "Base URL (the part before /chat/completions)"}
            <input value={baseUrl} readOnly={!!editing} onChange={(e) => setBaseUrl(e.target.value)} placeholder={usesClaude ? "https://gateway.example.com/v1" : "http://ollama.internal:11434/v1"} required maxLength={500} autoComplete="off" />
            {editing && <small className="muted">This saved key is bound to its URL. Add a new key to use a different endpoint.</small>}
          </label>
          <label>Authentication header<select value={authMode} onChange={e => setAuthMode(e.target.value)}>
            <option value="bearer">Authorization: Bearer &lt;API key&gt;</option><option value="x-api-key">x-api-key: &lt;API key&gt;</option><option value="custom">Custom header name</option>
          </select></label>
          {authMode === "custom" && <>
            <label>Header name<input value={headerName} onChange={e => setHeaderName(e.target.value)} placeholder="e.g. x-gateway-key" required maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9-]*" autoComplete="off" /></label>
            <label>Key format<select value={headerScheme} onChange={e => setHeaderScheme(e.target.value as "raw" | "bearer")}><option value="raw">API key directly</option><option value="bearer">Bearer + API key</option></select></label>
          </>}
          <p className="muted small">The selected header uses {editing ? "the saved API key" : "the API key below"}. Only that authentication header is sent.</p>
        </>)}
        {!editing && <label>
          API key{info.keyRequired ? "" : " (optional)"} (checked against the provider; the model list comes from the key)
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={info.keyPlaceholder}
            required={info.keyRequired}
            autoComplete="new-password"
          />
        </label>}
        {usesClaude && (
          <label>
            Workspace ID (only for a key created at the organization level, not inside a workspace)
            <input value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} placeholder="wrkspc_… (optional)" maxLength={120} autoComplete="off" />
          </label>
        )}
        {!usesClaude && (
          <p className="muted small">
            Agents call this provider's Chat Completions API with a bash tool. Pick a model with good tool use; on the Kubernetes driver, agents can only reach public
            HTTPS endpoints (port 443).
          </p>
        )}
        {!editing && <fieldset className="seg">
          <legend>Usable by departments (none = all)</legend>
          {(catalog?.departments ?? []).map((d) => (
            <label key={d.id}>
              <input
                type="checkbox"
                checked={departments.includes(d.id)}
                onChange={(e) => setDepartments(e.target.checked ? [...departments, d.id] : departments.filter((x) => x !== d.id))}
              />{" "}
              {d.name}
            </label>
          ))}
        </fieldset>}
        <div className="btn-row">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Checking key…" : editing ? "Save connection" : "Save key"}
          </button>
          {editing && <button type="button" disabled={busy} onClick={() => { setEditing(null); setApiKey(""); setBaseUrl(""); setWorkspaceId(""); }}>Cancel edit</button>}
        </div>
      </form>
    </Modal>
  );
}

/** Per-agent settings: which key, which model (from that key), effort, standing instructions. */
export function AgentConfigForm({ detail, departmentId, harness, notify }: { detail: AgentDetail; departmentId: string; harness: string | undefined; notify: Notify }) {
  const [creds, setCreds] = useState<Credential[] | null>(null);
  const [credentialId, setCredentialId] = useState(detail.config.credentialId ?? "");
  const [model, setModel] = useState(detail.config.model ?? "");
  const [effort, setEffort] = useState<string>(detail.config.effort ?? "");
  const [instructions, setInstructions] = useState(detail.config.instructions);
  const [maxTurns, setMaxTurns] = useState(detail.config.maxTurns);
  // Only rendered for people who hold agent.configure on this agent.
  useEffect(() => {
    api<{ credentials: Credential[] }>("GET", "/api/credentials")
      .then((r) => setCreds(r.credentials.filter((c) => !c.revokedAt && (!c.departments || c.departments.includes(departmentId)))))
      .catch((e) => notify(e.message, "error"));
  }, [departmentId]);

  const selected = creds?.find((c) => c.id === credentialId) ?? (detail.credential?.id === credentialId ? detail.credential : undefined);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api("PUT", `/api/agents/${detail.id}/config`, {
        credentialId: credentialId || null,
        model: model || null,
        effort: effort || null,
        instructions,
        maxTurns,
      });
      notify("Saved. A key change applies by replacing the runtime once the agent is idle.", "info");
    } catch (err) {
      notify((err as Error).message, "error");
    }
  };

  return (
    <form className="form" onSubmit={save}>
      {harness === "script" && <p className="muted small">This agent runs the deterministic script harness: model settings are stored but not used.</p>}
      <label>
        API key
        <select
          value={credentialId}
          onChange={(e) => {
            setCredentialId(e.target.value);
            setModel("");
          }}
        >
          <option value="">— none —</option>
          {(creds ?? (detail.credential ? [detail.credential] : [])).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.provider}, {c.keyHint})
            </option>
          ))}
        </select>
      </label>
      <label>
        Model (offered by this key)
        <select value={model} disabled={!selected} onChange={(e) => setModel(e.target.value)}>
          <option value="">{!selected || selected.provider === "anthropic" ? "template default" : "— choose a model —"}</option>
          {(selected?.models ?? []).map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </label>
      <label>
        Effort
        <select value={effort} onChange={(e) => setEffort(e.target.value)}>
          <option value="">model default</option>
          {EFFORTS.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </label>
      <label>
        Max turns per task
        <input type="number" min={1} max={200} value={maxTurns} onChange={(e) => setMaxTurns(Number(e.target.value))} />
      </label>
      <label>
        Standing instructions (added to the agent's system prompt)
        <textarea rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={8000} />
      </label>
      <div className="btn-row">
        <button type="submit" className="primary">
          Save config
        </button>
      </div>
    </form>
  );
}
