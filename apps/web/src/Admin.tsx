import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import type { Account } from "./types.ts";
import { Modal } from "./ui.tsx";

type Notify = (msg: string, kind?: "error" | "info") => void;

interface OrgRow {
  id: string;
  name: string;
  templateId: string | null;
  createdAt: string;
  archivedAt: string | null;
  runtimeNamespace: string | null;
  owner: { id: string; displayName: string } | null;
  agents: number;
  members: number;
}
interface TemplateRow {
  id: string;
  name: string;
  description: string;
  departments: string[];
}
interface AccountRow {
  id: string;
  displayName: string;
  admin: boolean;
  disabled: boolean;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/** Instance admin: every organization on this install, and new ones from templates. */
export function AdminDialog({ account, onClose, onChanged, onOpen, notify }: { account: Account; onClose: () => void; onChanged: () => void; onOpen: (id: string) => void; notify: Notify }) {
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [templateId, setTemplateId] = useState("company");
  const [owner, setOwner] = useState(account.user?.id ?? "");
  const [ownerName, setOwnerName] = useState("");
  const [issued, setIssued] = useState<{ org: string; token: string } | null>(null);

  const load = useCallback(() => api<{ orgs: OrgRow[] }>("GET", "/api/admin/orgs").then((r) => setOrgs(r.orgs)), []);
  useEffect(() => {
    void load().catch((e) => notify(e.message, "error"));
    api<{ templates: TemplateRow[] }>("GET", "/api/templates").then((r) => setTemplates(r.templates)).catch(() => {});
    api<{ users: AccountRow[] }>("GET", "/api/admin/users").then((r) => setAccounts(r.users.filter((u) => !u.disabled))).catch(() => {});
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
      onChanged();
    } catch (e) {
      notify((e as Error).message, "error");
    }
  };
  const create = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<{ org: OrgRow; ownerToken: string | null }>("POST", "/api/admin/orgs", {
        id,
        name,
        templateId,
        owner: owner ? { userId: owner } : { displayName: ownerName },
      });
      notify(`${r.org.name} created; its agents start once the cluster provisioner has run`, "info");
      if (r.ownerToken) setIssued({ org: r.org.name, token: r.ownerToken });
      setName("");
      setId("");
      setIdTouched(false);
    });
  };
  const template = templates.find((t) => t.id === templateId);
  const member = new Set(account.orgs.map((o) => o.id));

  return (
    <Modal title="Organizations" onClose={onClose} wide>
      <p className="muted small">
        Each organization has its own departments, agents, people, keys and audit log, and runs in its own namespace. Members of one never see another.
      </p>

      {issued && (
        <div className="review-box">
          <h3>Owner token for {issued.org}</h3>
          <p className="muted small">Shown once. Send it to the new owner privately.</p>
          <div className="form-row">
            <input readOnly value={issued.token} aria-label="Owner token" className="mono" onFocus={(e) => e.target.select()} />
            <button type="button" onClick={() => void navigator.clipboard.writeText(issued.token).then(() => notify("Copied", "info"))}>
              Copy
            </button>
            <button type="button" className="ghost" onClick={() => setIssued(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="grid mobile-cards">
          <thead>
            <tr>
              <th>Organization</th>
              <th>Template</th>
              <th>Owner</th>
              <th>Agents</th>
              <th>People</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(orgs ?? []).map((o) => (
              <tr key={o.id} className={o.archivedAt ? "muted" : ""}>
                <td>
                  <strong>{o.name}</strong> {o.archivedAt && <span className="tag">archived</span>}
                  <div className="muted small">
                    <code>{o.id}</code> · {o.runtimeNamespace ?? "per-department namespaces"}
                  </div>
                </td>
                <td data-label="Template" className="small">{o.templateId ?? "—"}</td>
                <td data-label="Owner" className="small">{o.owner?.displayName ?? "—"}</td>
                <td data-label="Agents" className="small">{o.agents}</td>
                <td data-label="People" className="small">{o.members}</td>
                <td>
                  <div className="btn-row">
                    {member.has(o.id) && !o.archivedAt && (
                      <button type="button" onClick={() => onOpen(o.id)}>
                        Open
                      </button>
                    )}
                    {o.archivedAt ? (
                      <button type="button" onClick={() => void run(() => api("PATCH", `/api/admin/orgs/${o.id}`, { archived: false }))}>
                        Restore
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="danger"
                        onClick={() => {
                          if (confirm(`Archive ${o.name}? Its runtimes stop and its members lose access until you restore it.`)) {
                            void run(() => api("PATCH", `/api/admin/orgs/${o.id}`, { archived: true }));
                          }
                        }}
                      >
                        Archive
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form className="form" onSubmit={create} style={{ marginTop: 16 }}>
        <h3>New organization</h3>
        <label>
          Template
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {template && (
          <p className="muted small">
            {template.description} Departments: {template.departments.join(", ")}.
          </p>
        )}
        <div className="form-row">
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!idTouched) setId(slug(e.target.value));
            }}
            placeholder="Name"
            required
            maxLength={80}
            aria-label="Name"
          />
          <input
            value={id}
            onChange={(e) => {
              setId(e.target.value);
              setIdTouched(true);
            }}
            placeholder="id (url, namespace)"
            required
            pattern="[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?"
            maxLength={40}
            aria-label="Organization id"
            className="mono"
          />
        </div>
        <div className="form-row">
          <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Owner">
            {accounts.map((u) => (
              <option key={u.id} value={u.id}>
                Owner: {u.displayName}
                {u.id === account.user?.id ? " (you)" : ""}
              </option>
            ))}
            <option value="">Owner: a new person…</option>
          </select>
          {!owner && <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="New owner's name" required maxLength={60} aria-label="New owner's name" />}
          <button type="submit" className="primary">
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}
