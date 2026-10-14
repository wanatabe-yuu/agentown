import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import type { AgentDetail, Catalog, Credential, Effort } from "./types.ts";
import { Modal, ago } from "./ui.tsx";

type Notify = (msg: string, kind?: "error" | "info") => void;
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Owner-only key manager. Keys are write-only: after saving you only ever see the last 4 characters. */
export function CredentialsDialog({ catalog, onClose, notify, now }: { catalog: Catalog | null; onClose: () => void; notify: Notify; now: number }) {
  const [rows, setRows] = useState<Credential[] | null>(null);
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [departments, setDepartments] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ credentials: Credential[] }>("GET", "/api/credentials").then((r) => setRows(r.credentials)), []);
  useEffect(() => void load().catch((e) => notify(e.message, "error")), [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const c = await api<Credential>("POST", "/api/credentials", { name, apiKey, workspaceId: workspaceId.trim() || null, departments: departments.length ? departments : null });
      notify(`Key "${c.name}" saved — ${c.models.length} models available`, "info");
      setName("");
      setApiKey("");
      setWorkspaceId("");
      setDepartments([]);
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
        Each agent uses one key and one model that key offers. Keys are encrypted at rest and only ever handed to the runtime of the agent configured to use them.
      </p>
      <div className="table-wrap">
        <table className="grid">
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
                    {c.provider} · {c.revokedAt ? `revoked ${ago(c.revokedAt, now)}` : `added ${ago(c.createdAt, now)}`}
                  </div>
                </td>
                <td>
                  <code>{c.keyHint}</code>
                  {c.workspaceId && <div className="muted small">{c.workspaceId}</div>}
                </td>
                <td className="small">{c.departments?.join(", ") ?? "all"}</td>
                <td className="small">{c.models.join(", ")}</td>
                <td>
                  {!c.revokedAt && (
                    <div className="btn-row">
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
      <form className="form" onSubmit={add} style={{ marginTop: 16 }}>
        <h3>Add a key</h3>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Engineering team key" required maxLength={60} />
        </label>
        <label>
          Anthropic API key (checked against the provider; the model list comes from the key)
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-ant-…" required autoComplete="off" />
        </label>
        <label>
          Workspace ID (only for a key created at the organization level, not inside a workspace)
          <input value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} placeholder="wrkspc_… (optional)" maxLength={120} autoComplete="off" />
        </label>
        <fieldset className="seg">
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
        </fieldset>
        <div className="btn-row">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Checking key…" : "Save key"}
          </button>
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
  const editable = !!detail.can["agent.configure"];

  useEffect(() => {
    if (!editable) return;
    api<{ credentials: Credential[] }>("GET", "/api/credentials")
      .then((r) => setCreds(r.credentials.filter((c) => !c.revokedAt && (!c.departments || c.departments.includes(departmentId)))))
      .catch((e) => notify(e.message, "error"));
  }, [editable, departmentId]);

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
      {!editable && <p className="muted small">Read-only: you do not hold agent.configure on this agent.</p>}
      <label>
        API key
        <select
          value={credentialId}
          disabled={!editable}
          onChange={(e) => {
            setCredentialId(e.target.value);
            setModel("");
          }}
        >
          <option value="">— none —</option>
          {(creds ?? (detail.credential ? [detail.credential] : [])).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.keyHint})
            </option>
          ))}
        </select>
      </label>
      <label>
        Model (offered by this key)
        <select value={model} disabled={!editable || !selected} onChange={(e) => setModel(e.target.value)}>
          <option value="">template default</option>
          {(selected?.models ?? []).map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </label>
      <label>
        Effort
        <select value={effort} disabled={!editable} onChange={(e) => setEffort(e.target.value)}>
          <option value="">model default</option>
          {EFFORTS.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </label>
      <label>
        Max turns per task
        <input type="number" min={1} max={200} value={maxTurns} disabled={!editable} onChange={(e) => setMaxTurns(Number(e.target.value))} />
      </label>
      <label>
        Standing instructions (added to the agent's system prompt)
        <textarea rows={4} value={instructions} disabled={!editable} onChange={(e) => setInstructions(e.target.value)} maxLength={8000} />
      </label>
      {editable && (
        <div className="btn-row">
          <button type="submit" className="primary">
            Save config
          </button>
        </div>
      )}
    </form>
  );
}
