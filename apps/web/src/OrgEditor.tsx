import { useCallback, useEffect, useState } from "react";
import { HttpError, api } from "./api.ts";
import type { Catalog, Snapshot } from "./types.ts";
import { ColorInput, Modal } from "./ui.tsx";
import { languageLabel, t as tr } from "./i18n.ts";
import { askConfirm } from "./dialogs.tsx";

type Notify = (msg: string, kind?: "error" | "info") => void;
/** The organization's document in its authoring format (the same shape as a template file). */
type Doc = Record<string, any>;
/** A capability as written in the document: scope is a shorthand string or { departments | agents | projects: [...] }. */
type Cap = { action: string; scope: string | Record<string, string[]>; templates?: string[]; delegable?: boolean };
type Tab = "departments" | "teams" | "projects" | "jobs" | "profiles" | "roles" | "templates";
const TAB_LABEL: Record<Tab, string> = { departments: "Departments", teams: "Teams", projects: "Projects", jobs: "Agent jobs", profiles: "Agent permissions", roles: "Role presets", templates: "Templates" };

// Mirrors ACTIONS in packages/core (code.* needs a repo list and is left to the YAML file).
const AGENT_ACTIONS = ["org.view", "task.view", "task.create", "task.assign", "task.review", "agent.spawn", "agent.update", "agent.retire", "agent.configure", "runtime.control", "runtime.logs", "runtime.exec", "permission.delegate"];
const PERSON_ACTIONS = [...AGENT_ACTIONS, "credential.manage", "audit.view", "org.design"];
const ORG_ONLY = ["credential.manage", "audit.view", "org.design"];
// Agents sit in the reporting tree, so tree-relative scopes make sense for them; people get org/departments/agents/projects.
const AGENT_SCOPES = ["self", "direct-reports", "descendants", "team", "department", "org", "departments", "agents", "projects"];
const PERSON_SCOPES = ["org", "departments", "agents", "projects"];

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
  // Ids already saved, per list: they stay as they are; new rows get theirs from their name.
  const [saved, setSaved] = useState<Record<IdList, Set<string>>>(savedIds({}));
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<Tab>("departments");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api<{ revision: number; doc: Doc }>("GET", "/api/config");
    setDoc(structuredClone(r.doc));
    setRevision(r.revision);
    setSaved(savedIds(r.doc));
    setDirty(false);
  }, []);
  useEffect(() => void load().catch((e) => notify(e.message, "error")), [load]);

  /** Rename a row; a row not saved yet takes its id from the name (unique in its list). */
  const rename = (list: IdList, i: number, field: string, value: string) =>
    edit((d) => {
      const row = d[list][i];
      row[field] = value;
      if (saved[list].has(row.id)) return;
      const taken = new Set<string>((d[list] as Doc[]).filter((_, j) => j !== i).map((r) => r.id));
      // A team named like a department would silently replace that department's default team.
      if (list === "teams") for (const dep of d.departments as Doc[]) taken.add(dep.id);
      row.id = slugId(value, taken, FALLBACK[list]);
    });

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
      setSaved(savedIds(r.doc));
      setDirty(false);
      notify("Saved. New hires and new role assignments use it right away.", "info");
    } catch (e) {
      if (e instanceof HttpError && e.status === 409 && (await askConfirm("Someone else changed the organization meanwhile. Reload their version (your unsaved edits are lost)?"))) await load();
      else notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  if (!doc) {
    return (
      <Modal title={tr("Organization")} onClose={onClose} wide>
        <p className="muted">{tr("Loading…")}</p>
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
    <Modal title={tr("Organization: {name}", { name: snapshot.organization.name })} onClose={() => void (async () => (!dirty || (await askConfirm("Discard unsaved changes?", { danger: true }))) && onClose())()} wide>
      <nav className="tabs" role="tablist">
        {(["departments", "teams", "projects", "jobs", "profiles", "roles", "templates"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {tr(TAB_LABEL[t])}
          </button>
        ))}
      </nav>
      {tab !== "templates" && (
        <div className="btn-row" style={{ margin: "10px 0" }}>
          <button type="button" className="primary" disabled={!dirty || busy} onClick={() => void save()}>
            {tr("Save changes")}
          </button>
          <button type="button" disabled={!dirty || busy} onClick={() => void load()}>
            {tr("Discard")}
          </button>
          <span className="muted small">{tr("Edits apply to new agents and new role assignments; permissions already handed out stay as they are.")}</span>
        </div>
      )}

      {tab === "departments" && (
        <RowsTable
          headers={["Name", "Color"]}
          rows={departments}
          onAdd={() => edit((d) => d.departments.push({ id: "", name: "", color: "#8899aa" }))}
          onRemove={(i) => edit((d) => d.departments.splice(i, 1))}
          render={(row, i) => [
            <input key="n" value={row.name} onChange={(e) => rename("departments", i, "name", e.target.value)} placeholder={tr("e.g. Kitchen")} aria-label={tr("Department name")} required />,
            <ColorInput key="c" value={row.color ?? "#8899aa"} onChange={(v) => edit((d) => (d.departments[i].color = v))} aria-label={tr("Department color")} />,
          ]}
          note="A department with agents cannot be removed."
        />
      )}

      {tab === "teams" && (
        <ul className="implicit-teams">
          {departments
            .filter((d) => !(doc.teams ?? []).some((x: Doc) => x.id === d.id))
            .map((d) => (
              <li key={d.id} className="muted small">
                <b>{d.name || d.id}</b> · {tr("Default team of {dept} (automatic)", { dept: d.name || d.id })} · {snapshot.teams.find((x) => x.id === d.id)?.memberIds.length ?? 0} 👤
              </li>
            ))}
        </ul>
      )}
      {tab === "teams" && (
        <RowsTable
          headers={["Name", "Department", "Runtime"]}
          rows={doc.teams ?? []}
          onAdd={() => edit((d) => (d.teams ??= []).push({ id: "", name: "", department: departments[0]?.id ?? "" }))}
          onRemove={(i) => edit((d) => d.teams.splice(i, 1))}
          render={(row, i) => [
            <input key="n" value={row.name} onChange={(e) => rename("teams", i, "name", e.target.value)} placeholder={tr("e.g. Morning shift")} aria-label={tr("Team name")} required />,
            <select key="d" value={row.department} onChange={(e) => edit((d) => (d.teams[i].department = e.target.value))} aria-label={tr("Team department")}>
              {departments.map((dep) => <option key={dep.id} value={dep.id}>{dep.name || dep.id}</option>)}
            </select>,
            <select key="p" value={row.runtimePreset ?? ""} onChange={(e) => edit((d) => { if (e.target.value) d.teams[i].runtimePreset = e.target.value; else delete d.teams[i].runtimePreset; })} aria-label={tr("Team runtime preset")}>
              <option value="">{tr("members' preset")}</option>
              {(catalog?.presets ?? []).map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
            </select>,
          ]}
          note="Each team shares one runtime, sized by the base of its preset plus every member's declared share. A department without a team of its own id keeps a default team with the department's id; a team with people cannot be removed."
        />
      )}

      {tab === "projects" && (
        <RowsTable
          headers={["Name"]}
          rows={projects}
          onAdd={() => edit((d) => (d.projects ??= []).push({ id: "", name: "" }))}
          onRemove={(i) => edit((d) => d.projects.splice(i, 1))}
          render={(row, i) => [
            <input key="n" value={row.name} onChange={(e) => rename("projects", i, "name", e.target.value)} placeholder={tr("e.g. Autumn menu")} aria-label={tr("Project name")} required />,
          ]}
          note="A project with open tasks cannot be removed."
        />
      )}

      {tab === "jobs" && (
        <RowsTable
          headers={["Job title", "Runtime", "Permissions"]}
          rows={jobs}
          onAdd={() => edit((d) => d.agentTemplates.push({ id: "", jobRole: "", runtimePreset: catalog?.presets[0]?.id ?? "", policyProfile: Object.keys(profiles)[0] ?? "" }))}
          onRemove={(i) => edit((d) => d.agentTemplates.splice(i, 1))}
          render={(row, i) => [
            <input key="r" value={row.jobRole} onChange={(e) => rename("agentTemplates", i, "jobRole", e.target.value)} placeholder={tr("e.g. Barista")} aria-label={tr("Job title")} required />,
            <select key="p" value={row.runtimePreset} onChange={(e) => edit((d) => (d.agentTemplates[i].runtimePreset = e.target.value))} aria-label={tr("Runtime")}>
              {(catalog?.presets ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} ({p.harness})
                </option>
              ))}
            </select>,
            <select key="pp" value={row.policyProfile} onChange={(e) => edit((d) => (d.agentTemplates[i].policyProfile = e.target.value))} aria-label={tr("Permission profile")}>
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
          onAdd={(key, name) => edit((d) => ((d.humanRoles ??= {})[key] = { name, permissions: [] }))}
          onRemove={(key) => edit((d) => delete d.humanRoles[key])}
          onChange={(key, caps, name) => edit((d) => (d.humanRoles[key] = { name: name ?? d.humanRoles[key].name, permissions: caps }))}
        />
      )}

      {tab === "templates" && <TemplatesTab orgId={orgId} dirty={dirty} notify={notify} />}
    </Modal>
  );
}

type IdList = "departments" | "teams" | "projects" | "agentTemplates";
const FALLBACK: Record<IdList, string> = { departments: "department", teams: "team", projects: "project", agentTemplates: "job" };

function savedIds(doc: Doc): Record<IdList, Set<string>> {
  const ids = (list: IdList) => new Set<string>(((doc[list] as Doc[] | undefined) ?? []).map((r) => r.id));
  return { departments: ids("departments"), teams: ids("teams"), projects: ids("projects"), agentTemplates: ids("agentTemplates") };
}

/** "Thực đơn mùa thu" → "thuc-don-mua-thu": a lowercase dns-label id, unique among `taken`. */
export function slugId(name: string, taken: Set<string>, fallback: string): string {
  const base =
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[đĐ]/g, "d")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, 34)
      .replace(/-+$/, "") || fallback;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

function RowsTable({ headers, rows, render, onAdd, onRemove, note }: { headers: string[]; rows: Doc[]; render: (row: Doc, i: number) => React.ReactNode[]; onAdd: () => void; onRemove: (i: number) => void; note: string }) {
  return (
    <section>
      <p className="muted small">{tr(note)}</p>
      <table className="grid mobile-cards">
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{tr(h)}</th>
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
                  {tr("Remove")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={onAdd} style={{ marginTop: 8 }}>
        {tr("Add")}
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
  onAdd: (key: string, name: string) => void;
  onRemove: (key: string) => void;
  onChange: (key: string, caps: Cap[], name?: string) => void;
}) {
  const keys = Object.keys(sets);
  const [open, setOpen] = useState(keys[0] ?? "");
  const [fresh, setFresh] = useState("");
  const current = sets[open];
  return (
    <section>
      <p className="muted small">{tr(note)}</p>
      <div className="form-row">
        <select value={open} onChange={(e) => setOpen(e.target.value)} aria-label={tr("Set")}>
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
            {tr("Remove")}
          </button>
        )}
        <input value={fresh} onChange={(e) => setFresh(e.target.value)} placeholder={tr("New name")} aria-label={tr("New name")} maxLength={60} />
        <button
          type="button"
          disabled={!fresh.trim()}
          onClick={() => {
            const key = slugId(fresh, new Set(keys), "set");
            onAdd(key, fresh.trim());
            setOpen(key);
            setFresh("");
          }}
        >
          {tr("Add")}
        </button>
      </div>
      {current && (
        <>
          {named && (
            <label>
              {tr("Display name")}
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
          <th>{tr("Action")}</th>
          <th>{tr("Scope")}</th>
          {withDelegable && <th>{tr("Delegable")}</th>}
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
              <td data-label={tr("Action")}>
                <select
                  value={c.action}
                  onChange={(e) =>
                    set(i, {
                      action: e.target.value,
                      ...(ORG_ONLY.includes(e.target.value) ? { scope: "org" } : {}),
                      templates: e.target.value === "agent.spawn" ? (c.templates ?? []) : undefined,
                    })
                  }
                  aria-label={tr("Action")}
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
              <td data-label={tr("Scope")}>
                {ORG_ONLY.includes(c.action) ? (
                  <span className="muted small">{tr("whole organization")}</span>
                ) : (
                  <select value={kind} onChange={(e) => set(i, { scope: makeScope(e.target.value, []) })} aria-label={tr("Scope")}>
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
                <td data-label={tr("Delegable")}>
                  <input type="checkbox" checked={!!c.delegable} onChange={(e) => set(i, { delegable: e.target.checked })} aria-label={tr("Delegable")} />
                </td>
              )}
              <td>
                <button type="button" className="danger" onClick={() => onChange(caps.filter((_, j) => j !== i))}>
                  {tr("Remove")}
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
              {tr("Add permission")}
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
  term?: string;
  departments: string[];
}

/** Save this organization as a template, and the person's template library (export, import, delete). */
function TemplatesTab({ orgId, dirty, notify }: { orgId: string; dirty: boolean; notify: Notify }) {
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [term, setTerm] = useState("");
  const [importTerm, setImportTerm] = useState("");
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
    if (!res.ok) return notify(tr("Export failed ({status})", { status: res.status }), "error");
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
          void run(() => api("POST", `/api/orgs/${orgId}/templates`, { name, description, ...(term.trim() ? { term: term.trim() } : {}) }).then(() => setName("")), tr("Saved to your templates"));
        }}
      >
        <h3>{tr("Save this organization as a template")}</h3>
        <p className="muted small">{tr("Departments, projects, jobs, permission profiles, role presets and today's agent tree. Never API keys, people or agents' instructions.")}</p>
        {dirty && <p className="error small">{tr("You have unsaved changes; the template uses the saved version.")}</p>}
        <div className="form-row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("Template name")} required maxLength={80} aria-label={tr("Template name")} />
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={tr("Description")} maxLength={500} aria-label={tr("Description")} />
          <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder={tr("What its world is called (e.g. café, factory)")} maxLength={40} aria-label={tr("What its world is called (e.g. café, factory)")} />
          <button type="submit" className="primary">
            {tr("Save as template")}
          </button>
        </div>
      </form>

      <h3 style={{ marginTop: 16 }}>{tr("Templates")}</h3>
      <table className="grid mobile-cards">
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td>
                <strong>{t.name}</strong> {t.builtIn && <span className="tag">{tr("built-in")}</span>}
                <div className="muted small">
                  {t.term && <>{tr("Called “{term}”", { term: tr(t.term) })} · </>}
                  {t.description || t.departments.join(", ")}
                </div>
              </td>
              <td>
                <div className="btn-row">
                  <button type="button" onClick={() => void download(t)}>
                    {tr("Export YAML")}
                  </button>
                  {!t.builtIn && (
                    <button type="button" className="danger" onClick={() => void askConfirm(tr("Delete template {name}?", { name: t.name }), { danger: true }).then((ok) => void (ok && run(() => api("DELETE", `/api/templates/${t.id}`), tr("Deleted"))))}>
                      {tr("Delete")}
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <label style={{ marginTop: 12, display: "block" }}>
        {tr("What its world is called (e.g. café, factory)")}
        <input value={importTerm} onChange={(e) => setImportTerm(e.target.value)} maxLength={40} />
        <small className="muted">{tr("Shown as “{example}” in Settings. Leave empty to keep the file's own.", { example: languageLabel(importTerm.trim() || "café") })}</small>
      </label>
      <label style={{ marginTop: 12, display: "block" }}>
        {tr("Import a template file (.yaml)")}
        <input
          type="file"
          accept=".yaml,.yml,text/yaml"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void run(async () => api("POST", "/api/templates", { yaml: await f.text(), ...(importTerm.trim() ? { term: importTerm.trim() } : {}) }).then(() => setImportTerm("")), tr("Imported {file}", { file: f.name }));
          }}
        />
      </label>
      <p className="muted small">{tr("The instance admin can create new organizations from any of these (Organizations).")}</p>
    </section>
  );
}
