import { useCallback, useEffect, useState } from "react";
import { t as tr } from "./i18n.ts";
import { api } from "./api.ts";
import type { Catalog, Me, Role, Scope, Snapshot, User } from "./types.ts";
import { Modal, describeScope } from "./ui.tsx";

type Notify = (msg: string, kind?: "error" | "info") => void;

// Mirrors ACTIONS in packages/core (code.* needs a repo list and is not offered here).
const ACTIONS = [
  "org.view",
  "task.view",
  "task.create",
  "task.assign",
  "task.review",
  "agent.spawn",
  "agent.update",
  "agent.retire",
  "agent.configure",
  "runtime.control",
  "runtime.logs",
  "runtime.exec",
  "permission.delegate",
  "credential.manage",
  "audit.view",
  "user.manage",
  "org.design",
];
const ORG_ACTIONS = ["credential.manage", "audit.view", "user.manage", "org.design"];
type ScopeKind = "org" | "departments" | "agents" | "projects";

/** People and their permissions. A role only fills in a starting set; each permission is then added or removed on its own. */
export function UsersDialog({ me, catalog, snapshot, onClose, notify }: { me: Me; catalog: Catalog | null; snapshot: Snapshot; onClose: () => void; notify: Notify }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState("");
  const [issued, setIssued] = useState<{ who: string; token: string } | null>(null);
  const [existing, setExisting] = useState("");

  const load = useCallback(() => api<{ users: User[] }>("GET", "/api/users").then((r) => setUsers(r.users)), []);
  useEffect(() => {
    void load().catch((e) => notify(e.message, "error"));
    api<{ roles: Role[] }>("GET", "/api/roles").then((r) => setRoles(r.roles)).catch(() => {});
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      notify((e as Error).message, "error");
    }
  };
  const invite = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<{ user: User; token: string }>("POST", "/api/users", { displayName: name, roleId: roleId || null });
      setIssued({ who: r.user.displayName, token: r.token });
      setOpen(r.user.id);
      setName("");
    });
  };
  const resetToken = (u: User) => {
    if (!confirm(`Issue a new token for ${u.displayName}? Their current token stops working.`)) return;
    void run(async () => {
      const r = await api<{ token: string }>("POST", `/api/users/${u.id}/token`);
      setIssued({ who: u.displayName, token: r.token });
    });
  };

  return (
    <Modal title={tr("People")} onClose={onClose} wide>
      <p className="muted small">
        {tr("A role is only a starting point: it copies a set of permissions onto the person. Add or remove single permissions below. People see and use only what their permissions allow; the server checks every request.")}
      </p>

      {issued && (
        <div className="review-box">
          <h3>Token for {issued.who}</h3>
          <p className="muted small">{tr("Shown once. Send it to them privately; they paste it on the sign-in screen.")}</p>
          <div className="form-row">
            <input readOnly value={issued.token} aria-label={tr("New token")} onFocus={(e) => e.target.select()} className="mono" />
            <button type="button" onClick={() => void navigator.clipboard.writeText(issued.token).then(() => notify("Copied", "info"))}>
              {tr("Copy")}
            </button>
            <button type="button" className="ghost" onClick={() => setIssued(null)}>
              {tr("Done")}
            </button>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="grid mobile-cards">
          <thead>
            <tr>
              <th>{tr("Person")}</th>
              <th>{tr("Role")}</th>
              <th>{tr("Permissions")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(users ?? []).map((u) => {
              const editable = !u.owner && u.id !== me.actor.id;
              return (
                <tr key={u.id} className={u.disabledAt ? "muted" : ""}>
                  <td>
                    <strong>{u.displayName}</strong> {u.owner && <span className="tag">owner</span>}
                    {u.disabledAt && <span className="tag">{tr("disabled")}</span>}
                    <div className="muted small">
                      <code>{u.id}</code>
                    </div>
                  </td>
                  <td data-label={tr("Role")} className="small">{u.owner ? tr("everything") : (roles.find((r) => r.id === u.roleId)?.name ?? tr("custom"))}</td>
                  <td data-label={tr("Permissions")} className="small">{u.owner ? "—" : u.permissions.length}</td>
                  <td>
                    {editable && (
                      <div className="btn-row">
                        <button type="button" onClick={() => setOpen(open === u.id ? null : u.id)}>
                          {open === u.id ? tr("Close") : tr("Permissions")}
                        </button>
                        <button type="button" onClick={() => resetToken(u)}>
                          {tr("New token")}
                        </button>
                        <button type="button" className={u.disabledAt ? "" : "danger"} onClick={() => void run(() => api("PATCH", `/api/users/${u.id}`, { disabled: !u.disabledAt }))}>
                          {u.disabledAt ? tr("Enable") : tr("Disable")}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {open && users?.find((u) => u.id === open) && (
        <UserPermissions user={users.find((u) => u.id === open)!} roles={roles} catalog={catalog} snapshot={snapshot} run={run} />
      )}

      <form
        className="form"
        style={{ marginTop: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api("POST", "/api/users/members", { userId: existing.trim() }).then(() => setExisting("")));
        }}
      >
        <h3>{tr("Add someone from another organization")}</h3>
        <p className="muted small">{tr("They keep their account and sign-in; here they start with no permissions. Their user id is shown under their name in the other organization.")}</p>
        <div className="form-row">
          <input value={existing} onChange={(e) => setExisting(e.target.value)} placeholder="u-…" required className="mono" aria-label={tr("User id")} />
          <button type="submit">{tr("Add")}</button>
        </div>
      </form>

      <form className="form" onSubmit={invite} style={{ marginTop: 16 }}>
        <h3>{tr("Invite someone")}</h3>
        <div className="form-row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("Name")} required maxLength={60} aria-label={tr("Name")} />
          <select value={roleId} onChange={(e) => setRoleId(e.target.value)} aria-label={tr("Starting role")}>
            <option value="">{tr("no permissions yet")}</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button type="submit" className="primary">
            {tr("Invite")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function UserPermissions({ user, roles, catalog, snapshot, run }: { user: User; roles: Role[]; catalog: Catalog | null; snapshot: Snapshot; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [action, setAction] = useState("org.view");
  const [kind, setKind] = useState<ScopeKind>("org");
  const [ids, setIds] = useState<string[]>([]);
  const [templates, setTemplates] = useState<string[]>([]);
  const [roleId, setRoleId] = useState(user.roleId ?? "");
  const orgOnly = ORG_ACTIONS.includes(action);
  const options: Array<{ id: string; name: string }> =
    kind === "departments" ? snapshot.departments : kind === "projects" ? snapshot.projects : kind === "agents" ? snapshot.agents.filter((a) => a.lifecycleState !== "retired").map((a) => ({ id: a.id, name: a.displayName })) : [];

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const scope: Scope = orgOnly || kind === "org" ? { kind: "org" } : { kind, ids };
    void run(() =>
      api("POST", `/api/users/${user.id}/grants`, { action, scope, constraints: action === "agent.spawn" ? { templates } : {} }).then(() => {
        setIds([]);
        setTemplates([]);
      }),
    );
  };
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <section className="actions">
      <h3>{tr("Permissions of {name}", { name: user.displayName })}</h3>
      <table className="grid mobile-cards">
        <thead>
          <tr>
            <th>{tr("Action")}</th>
            <th>{tr("Scope")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {user.permissions.map((p) => (
            <tr key={p.id}>
              <td>
                <code>{p.action}</code>
                {p.constraints.templates && <div className="muted small">templates: {p.constraints.templates.join(", ")}</div>}
              </td>
              <td data-label={tr("Scope")} className="small">{describeScope(p.scope)}</td>
              <td>
                <button type="button" className="danger" onClick={() => void run(() => api("DELETE", `/api/users/${user.id}/grants/${p.id}`))}>
                  {tr("Remove")}
                </button>
              </td>
            </tr>
          ))}
          {user.permissions.length === 0 && (
            <tr>
              <td colSpan={3} className="muted">
                {tr("No permissions: this person sees nothing.")}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <form className="form" onSubmit={add}>
        <div className="form-row">
          <select value={action} onChange={(e) => setAction(e.target.value)} aria-label={tr("Action")}>
            {ACTIONS.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          {!orgOnly && (
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as ScopeKind);
                setIds([]);
              }}
              aria-label={tr("Scope")}
            >
              <option value="org">{tr("whole organization")}</option>
              <option value="departments">{tr("departments…")}</option>
              <option value="agents">{tr("agents…")}</option>
              <option value="projects">{tr("projects…")}</option>
            </select>
          )}
          <button type="submit" disabled={!orgOnly && kind !== "org" && !ids.length}>
            {tr("Add permission")}
          </button>
        </div>
        {!orgOnly && kind !== "org" && (
          <div className="checks">
            {options.map((o) => (
              <label key={o.id}>
                <input type="checkbox" checked={ids.includes(o.id)} onChange={() => toggle(ids, setIds, o.id)} /> {o.name}
              </label>
            ))}
          </div>
        )}
        {action === "agent.spawn" && (
          <div className="checks">
            <span className="muted small">{tr("May hire from:")}</span>
            {(catalog?.templates ?? []).map((t) => (
              <label key={t.id}>
                <input type="checkbox" checked={templates.includes(t.id)} onChange={() => toggle(templates, setTemplates, t.id)} /> {t.id}
              </label>
            ))}
          </div>
        )}
      </form>

      <div className="form-row">
        <select value={roleId} onChange={(e) => setRoleId(e.target.value)} aria-label={tr("Role preset")}>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!roleId}
          onClick={() => {
            if (confirm(`Replace all of ${user.displayName}'s permissions with the "${roles.find((r) => r.id === roleId)?.name}" preset?`)) {
              void run(() => api("PATCH", `/api/users/${user.id}`, { roleId }));
            }
          }}
        >
          {tr("Apply preset (replaces all)")}
        </button>
      </div>
    </section>
  );
}
