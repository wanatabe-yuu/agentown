import { useCallback, useEffect, useState } from "react";
import { HttpError, api } from "./api.ts";
import type { Catalog, Snapshot } from "./types.ts";
import { Modal } from "./ui.tsx";

type Notify = (msg: string, kind?: "error" | "info") => void;
/** The organization's document in its authoring format (the same shape as a template file). */
type Doc = Record<string, any>;
/** A capability as written in the document: scope is a shorthand string or { departments | agents | projects: [...] }. */
type Cap = { action: string; scope: string | Record<string, string[]>; templates?: string[]; delegable?: boolean };
type Tab = "departments" | "teams" | "projects" | "jobs" | "profiles" | "roles" | "templates";

// Mirrors ACTIONS in packages/core (code.* needs a repo list and is left to the YAML file).
const AGENT_ACTIONS = ["org.view", "task.view", "task.create", "task.assign", "task.review", "agent.spawn", "agent.update", "agent.retire", "agent.configure", "runtime.control", "runtime.logs", "runtime.exec", "permission.delegate"];
const PERSON_ACTIONS = [...AGENT_ACTIONS, "credential.manage", "audit.view", "org.design"];
const ORG_ONLY = ["credential.manage", "audit.view", "org.design"];
// Agents sit in the reporting tree, so tree-relative scopes make sense for them; people get org/departments/agents/projects.
const AGENT_SCOPES = ["self", "direct-reports", "descendants", "team", "department", "org", "departments", "agents", "projects"];
const PERSON_SCOPES = ["org", "departments", "agents", "projects"];
const ID = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

const scopeKind = (s: Cap["scope"]) => (typeof s === "string" ? s : Object.keys(s)[0]!);
const scopeIds = (s: Cap["scope"]) => (typeof s === "string" ? [] : (Object.values(s)[0] ?? []));
const makeScope = (kind: string, ids: string[]): Cap["scope"] => (["departments", "agents", "projects"].includes(kind) ? { [kind]: ids } : kind);

/**
 * The owner's editor for the organization's structure. Changes apply to new
 * agents and new role assignments at once; grants already handed out stay.
 */
export function OrgEditor({ orgId, catalog, snapshot, onClose, notify }: { orgId: string; catalog: Catalog | null; snapshot: Snapshot; onClose: () => void; notify: Notify }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [revision, setRevision] = useState(0);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<Tab>("departments");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api<{ revision: number; doc: Doc }>("GET", "/api/config");
    setDoc(structuredClone(r.doc));
    setRevision(r.revision);
    setSaved(new Set((r.doc.departments as Doc[]).map((d) => d.id)));
    setDirty(false);
  }, []);
  useEffect(() => void load().catch((e) => notify(e.message, "error")), [load]);

  /** Edit a copy of the document; every editor below goes through this. */
  const edit = (fn: (d: Doc) => void) => {
    setDoc((d) => {
      const next = structuredClone(d!);
      fn(next);
      return next;
    });
    setDirty(true);
  };

  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ revision: number; doc: Doc }>("PUT", "/api/config", { revision, doc });
      setRevision(r.revision);
      setSaved(new Set((r.doc.departments as Doc[]).map((d) => d.id)));
      setDirty(false);
      notify("Saved. New hires and new role assignments use it right away.", "info");
    } catch (e) {
      if (e instanceof HttpError && e.status === 409 && confirm("Someone else changed the organization meanwhile. Reload their version (your unsaved edits are lost)?")) await load();
      else notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  if (!doc) {
    return (
      <Modal title="Organization" onClose={onClose} wide>
        <p className="muted">Loading…</p>
      </Modal>
    );
  }
  const departments: Doc[] = doc.departments;
  const projects: Doc[] = doc.projects ?? [];
  const jobs: Doc[] = doc.agentTemplates;
  const profiles: Record<string, Cap[]> = doc.policyProfiles;
  const roles: Record<string, { name: string; permissions: Cap[] }> = doc.humanRoles ?? {};
  const lists = {
    departments: departments.map((d) => ({ id: d.id, name: d.name })),
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    agents: snapshot.agents.filter((a) => a.lifecycleState !== "retired").map((a) => ({ id: a.id, name: a.displayName })),
    templates: jobs.map((j) => ({ id: j.id, name: j.id })),
  };

  return (
    <Modal title={`Organization: ${snapshot.organization.name}`} onClose={() => (!dirty || confirm("Discard unsaved changes?")) && onClose()} wide>
      <nav className="tabs" role="tablist">
        {(["departments", "teams", "projects", "jobs", "profiles", "roles", "templates"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t === "jobs" ? "agent jobs" : t === "profiles" ? "agent permissions" : t === "roles" ? "role presets" : t}
          </button>
        ))}
      </nav>
      {tab !== "templates" && (
        <div className="btn-row" style={{ margin: "10px 0" }}>
          <button type="button" className="primary" disabled={!dirty || busy} onClick={() => void save()}>
            Save changes
          </button>
          <button type="button" disabled={!dirty || busy} onClick={() => void load()}>
            Discard
          </button>
          <span className="muted small">Edits apply to new agents and new role assignments; permissions already handed out stay as they are.</span>
        </div>
      )}

      {tab === "departments" && (
        <RowsTable
          headers={["Id", "Name", "Color"]}
          rows={departments}
          onAdd={() => edit((d) => d.departments.push({ id: "", name: "", color: "#8899aa" }))}
          onRemove={(i) => edit((d) => d.departments.splice(i, 1))}
          render={(row, i) => [
            <IdInput key="id" value={row.id} locked={saved.has(row.id)} onChange={(v) => edit((d) => (d.departments[i].id = v))} />,
            <input key="n" value={row.name} onChange={(e) => edit((d) => (d.departments[i].name = e.target.value))} aria-label="Department name" />,
            <input key="c" type="color" value={row.color ?? "#8899aa"} onChange={(e) => edit((d) => (d.departments[i].color = e.target.value))} aria-label="Department color" />,
          ]}
          note="A department's id is fixed once saved (it names namespaces, scopes and seats). A department with agents cannot be removed."
        />
      )}

      {tab === "teams" && (
        <RowsTable
          headers={["Id", "Name", "Department", "Runtime"]}
          rows={doc.teams ?? []}
          onAdd={() => edit((d) => (d.teams ??= []).push({ id: "", name: "", department: departments[0]?.id ?? "" }))}
          onRemove={(i) => edit((d) => d.teams.splice(i, 1))}
          render={(row, i) => [
            <IdInput key="id" value={row.id} onChange={(v) => edit((d) => (d.teams[i].id = v))} />,
            <input key="n" value={row.name} onChange={(e) => edit((d) => (d.teams[i].name = e.target.value))} aria-label="Team name" />,
            <select key="d" value={row.department} onChange={(e) => edit((d) => (d.teams[i].department = e.target.value))} aria-label="Team department">
              {departments.map((dep) => <option key={dep.id} value={dep.id}>{dep.name || dep.id}</option>)}
            </select>,
            <select key="p" value={row.runtimePreset ?? ""} onChange={(e) => edit((d) => { if (e.target.value) d.teams[i].runtimePreset = e.target.value; else delete d.teams[i].runtimePreset; })} aria-label="Team runtime preset">
              <option value="">members' preset</option>
              {(catalog?.presets ?? []).map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
            </select>,
          ]}
          note="Each team shares one runtime, sized by the base of its preset plus every member's declared share. A department without a team of its own id keeps a default team with the department's id; a team with people cannot be removed."
        />
      )}

      {tab === "projects" && (
        <RowsTable
          headers={["Id", "Name"]}
          rows={projects}
          onAdd={() => edit((d) => (d.projects ??= []).push({ id: "", name: "" }))}
          onRemove={(i) => edit((d) => d.projects.splice(i, 1))}
          render={(row, i) => [
            <IdInput key="id" value={row.id} onChange={(v) => edit((d) => (d.projects[i].id = v))} />,
            <input key="n" value={row.name} onChange={(e) => edit((d) => (d.projects[i].name = e.target.value))} aria-label="Project name" />,
          ]}
          note="A project with open tasks cannot be removed."
        />
      )}

      {tab === "jobs" && (
        <RowsTable
          headers={["Id", "Job title", "Runtime", "Permissions"]}
          rows={jobs}
          onAdd={() => edit((d) => d.agentTemplates.push({ id: "", jobRole: "", runtimePreset: catalog?.presets[0]?.id ?? "", policyProfile: Object.keys(profiles)[0] ?? "" }))}
          onRemove={(i) => edit((d) => d.agentTemplates.splice(i, 1))}
          render={(row, i) => [
            <IdInput key="id" value={row.id} onChange={(v) => edit((d) => (d.agentTemplates[i].id = v))} />,
            <input key="r" value={row.jobRole} onChange={(e) => edit((d) => (d.agentTemplates[i].jobRole = e.target.value))} aria-label="Job title" />,
            <select key="p" value={row.runtimePreset} onChange={(e) => edit((d) => (d.agentTemplates[i].runtimePreset = e.target.value))} aria-label="Runtime">
              {(catalog?.presets ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} ({p.harness})
                </option>
              ))}
            </select>,
            <select key="pp" value={row.policyProfile} onChange={(e) => edit((d) => (d.agentTemplates[i].policyProfile = e.target.value))} aria-label="Permission profile">
              {Object.keys(profiles).map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>,
          ]}
          note="Runtimes come from the install's approved catalog. Removing a job leaves agents already hired with it running; it just cannot be hired again."
        />
      )}

      {tab === "profiles" && (
        <NamedCapSets
          sets={Object.fromEntries(Object.entries(profiles).map(([k, v]) => [k, { name: k, permissions: v }]))}
          actions={AGENT_ACTIONS}
          scopes={AGENT_SCOPES}
          lists={lists}
          withDelegable
          note="What an agent hired with a job gets. Scopes like team or direct-reports follow the reporting tree as it changes."
          onAdd={(key) => edit((d) => (d.policyProfiles[key] = []))}
          onRemove={(key) => edit((d) => delete d.policyProfiles[key])}
          onChange={(key, caps) => edit((d) => (d.policyProfiles[key] = caps))}
        />
      )}

      {tab === "roles" && (
        <NamedCapSets
          sets={roles}
          actions={PERSON_ACTIONS}
          scopes={PERSON_SCOPES}
          lists={lists}
          named
          note="Starting points for people (Users → invite). Picking a role copies these permissions; each can then be changed per person."
          onAdd={(key) => edit((d) => ((d.humanRoles ??= {})[key] = { name: key, permissions: [] }))}
          onRemove={(key) => edit((d) => delete d.humanRoles[key])}
          onChange={(key, caps, name) => edit((d) => (d.humanRoles[key] = { name: name ?? d.humanRoles[key].name, permissions: caps }))}
        />
      )}

      {tab === "templates" && <TemplatesTab orgId={orgId} dirty={dirty} notify={notify} />}
    </Modal>
  );
}

function IdInput({ value, locked, onChange }: { value: string; locked?: boolean; onChange: (v: string) => void }) {
  return (
    <input
      value={value}
      readOnly={locked}
      onChange={(e) => onChange(e.target.value.toLowerCase())}
      className={`mono ${value && !ID.test(value) ? "invalid" : ""}`}
      placeholder="id"
      maxLength={40}
      aria-label="Id"
      title={locked ? "Fixed once saved" : "lowercase letters, digits, dashes"}
    />
  );
}

function RowsTable({ headers, rows, render, onAdd, onRemove, note }: { headers: string[]; rows: Doc[]; render: (row: Doc, i: number) => React.ReactNode[]; onAdd: () => void; onRemove: (i: number) => void; note: string }) {
  return (
    <section>
      <p className="muted small">{note}</p>
      <table className="grid mobile-cards">
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {render(row, i).map((cell, j) => (
                <td key={j} data-label={headers[j]}>{cell}</td>
              ))}
              <td>
                <button type="button" className="danger" onClick={() => onRemove(i)}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={onAdd} style={{ marginTop: 8 }}>
        Add
      </button>
    </section>
  );
}

type Lists = Record<"departments" | "projects" | "agents" | "templates", Array<{ id: string; name: string }>>;

/** Named sets of capabilities: agent permission profiles, or role presets for people. */
function NamedCapSets({
  sets,
  actions,
  scopes,
  lists,
  withDelegable,
  named,
  note,
  onAdd,
  onRemove,
  onChange,
}: {
  sets: Record<string, { name: string; permissions: Cap[] }>;
  actions: string[];
  scopes: string[];
  lists: Lists;
  withDelegable?: boolean;
  named?: boolean;
  note: string;
  onAdd: (key: string) => void;
  onRemove: (key: string) => void;
  onChange: (key: string, caps: Cap[], name?: string) => void;
}) {
  const keys = Object.keys(sets);
  const [open, setOpen] = useState(keys[0] ?? "");
  const [fresh, setFresh] = useState("");
  const current = sets[open];
  return (
    <section>
      <p className="muted small">{note}</p>
      <div className="form-row">
        <select value={open} onChange={(e) => setOpen(e.target.value)} aria-label="Set">
          {keys.map((k) => (
            <option key={k} value={k}>
              {named ? `${sets[k]!.name} (${k})` : k}
            </option>
          ))}
        </select>
        {current && (
          <button
            type="button"
            className="danger"
            onClick={() => {
              onRemove(open);
              setOpen(keys.find((k) => k !== open) ?? "");
            }}
          >
            Remove
          </button>
        )}
        <input value={fresh} onChange={(e) => setFresh(e.target.value.toLowerCase())} placeholder="new id" className="mono" aria-label="New id" />
        <button
          type="button"
          disabled={!ID.test(fresh) || keys.includes(fresh)}
          onClick={() => {
            onAdd(fresh);
            setOpen(fresh);
            setFresh("");
          }}
        >
          Add
        </button>
      </div>
      {current && (
        <>
          {named && (
            <label>
              Display name
              <input value={current.name} onChange={(e) => onChange(open, current.permissions, e.target.value)} />
            </label>
          )}
          <CapRows caps={current.permissions} actions={actions} scopes={scopes} lists={lists} withDelegable={withDelegable} onChange={(caps) => onChange(open, caps)} />
        </>
      )}
    </section>
  );
}

function CapRows({ caps, actions, scopes, lists, withDelegable, onChange }: { caps: Cap[]; actions: string[]; scopes: string[]; lists: Lists; withDelegable?: boolean; onChange: (caps: Cap[]) => void }) {
  const set = (i: number, patch: Partial<Cap>) => onChange(caps.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  return (
    <table className="grid mobile-cards">
      <thead>
        <tr>
          <th>Action</th>
          <th>Scope</th>
          {withDelegable && <th>Delegable</th>}
          <th />
        </tr>
      </thead>
      <tbody>
        {caps.map((c, i) => {
          const kind = scopeKind(c.scope);
          const ids = scopeIds(c.scope);
          const pick = kind === "departments" || kind === "agents" || kind === "projects" ? lists[kind] : null;
          return (
            <tr key={i}>
              <td data-label="Action">
                <select
                  value={c.action}
                  onChange={(e) =>
                    set(i, {
                      action: e.target.value,
                      ...(ORG_ONLY.includes(e.target.value) ? { scope: "org" } : {}),
                      templates: e.target.value === "agent.spawn" ? (c.templates ?? []) : undefined,
                    })
                  }
                  aria-label="Action"
                >
                  {actions.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
                {c.action === "agent.spawn" && (
                  <div className="checks small">
                    may hire:
                    {lists.templates.map((t) => (
                      <label key={t.id}>
                        <input type="checkbox" checked={(c.templates ?? []).includes(t.id)} onChange={() => set(i, { templates: toggle(c.templates ?? [], t.id) })} /> {t.id}
                      </label>
                    ))}
                  </div>
                )}
              </td>
              <td data-label="Scope">
                {ORG_ONLY.includes(c.action) ? (
                  <span className="muted small">whole organization</span>
                ) : (
                  <select value={kind} onChange={(e) => set(i, { scope: makeScope(e.target.value, []) })} aria-label="Scope">
                    {scopes.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                )}
                {pick && (
                  <div className="checks small">
                    {pick.map((o) => (
                      <label key={o.id}>
                        <input type="checkbox" checked={ids.includes(o.id)} onChange={() => set(i, { scope: makeScope(kind, toggle(ids, o.id)) })} /> {o.name}
                      </label>
                    ))}
                  </div>
                )}
              </td>
              {withDelegable && (
                <td data-label="Delegable">
                  <input type="checkbox" checked={!!c.delegable} onChange={(e) => set(i, { delegable: e.target.checked })} aria-label="Delegable" />
                </td>
              )}
              <td>
                <button type="button" className="danger" onClick={() => onChange(caps.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={withDelegable ? 4 : 3}>
            <button type="button" onClick={() => onChange([...caps, { action: "org.view", scope: scopes.includes("team") ? "self" : "org" }])}>
              Add permission
            </button>
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

interface TemplateRow {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  departments: string[];
}

/** Save this organization as a template, and the person's template library (export, import, delete). */
function TemplatesTab({ orgId, dirty, notify }: { orgId: string; dirty: boolean; notify: Notify }) {
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const load = useCallback(() => api<{ templates: TemplateRow[] }>("GET", "/api/templates").then((r) => setRows(r.templates)), []);
  useEffect(() => void load().catch(() => {}), [load]);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      await load();
      notify(ok, "info");
    } catch (e) {
      notify((e as Error).message, "error");
    }
  };
  const download = async (t: TemplateRow) => {
    const res = await fetch(`/api/templates/${t.id}/export`);
    if (!res.ok) return notify(`Export failed (${res.status})`, "error");
    const url = URL.createObjectURL(new Blob([await res.text()], { type: "text/yaml" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${t.name.replace(/[^\w-]+/g, "-")}.yaml` });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api("POST", `/api/orgs/${orgId}/templates`, { name, description }).then(() => setName("")), "Saved to your templates");
        }}
      >
        <h3>Save this organization as a template</h3>
        <p className="muted small">Departments, projects, jobs, permission profiles, role presets and today's agent tree. Never API keys, people or agents' instructions.</p>
        {dirty && <p className="error small">You have unsaved changes; the template uses the saved version.</p>}
        <div className="form-row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name" required maxLength={80} aria-label="Template name" />
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" maxLength={500} aria-label="Description" />
          <button type="submit" className="primary">
            Save as template
          </button>
        </div>
      </form>

      <h3 style={{ marginTop: 16 }}>Templates</h3>
      <table className="grid mobile-cards">
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td>
                <strong>{t.name}</strong> {t.builtIn && <span className="tag">built-in</span>}
                <div className="muted small">{t.description || t.departments.join(", ")}</div>
              </td>
              <td>
                <div className="btn-row">
                  <button type="button" onClick={() => void download(t)}>
                    Export YAML
                  </button>
                  {!t.builtIn && (
                    <button type="button" className="danger" onClick={() => confirm(`Delete template ${t.name}?`) && void run(() => api("DELETE", `/api/templates/${t.id}`), "Deleted")}>
                      Delete
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <label style={{ marginTop: 12, display: "block" }}>
        Import a template file (.yaml)
        <input
          type="file"
          accept=".yaml,.yml,text/yaml"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void run(async () => api("POST", "/api/templates", { yaml: await f.text() }), `Imported ${f.name}`);
          }}
        />
      </label>
      <p className="muted small">The instance admin can create new organizations from any of these (Organizations).</p>
    </section>
  );
}
