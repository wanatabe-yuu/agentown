import { useCallback, useEffect, useState } from "react";
import { t as tr } from "./i18n.ts";
import { CreateWorldDialog } from "./CreateWorld.tsx";
import { api } from "./api.ts";
import type { Account } from "./types.ts";
import { Modal } from "./ui.tsx";
import { askConfirm } from "./dialogs.tsx";

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
/** Instance admin: every organization on this install, and new ones from templates. */
export function AdminDialog({ account, onClose, onChanged, onOpen, notify }: { account: Account; onClose: () => void; onChanged: () => void; onOpen: (id: string) => void; notify: Notify }) {
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => api<{ orgs: OrgRow[] }>("GET", "/api/admin/orgs").then((r) => setOrgs(r.orgs)), []);
  useEffect(() => {
    void load().catch((e) => notify(e.message, "error"));
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
  const member = new Set(account.orgs.map((o) => o.id));

  return (
    <Modal title={tr("Organizations")} onClose={onClose} wide>
      <p className="muted small">
        {tr("Each organization has its own departments, agents, people, keys and audit log, and runs in its own namespace. Members of one never see another.")}
      </p>

      <div className="table-wrap">
        <table className="grid mobile-cards">
          <thead>
            <tr>
              <th>{tr("Organization")}</th>
              <th>{tr("Template")}</th>
              <th>{tr("Owner")}</th>
              <th>{tr("Agents")}</th>
              <th>{tr("People")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(orgs ?? []).map((o) => (
              <tr key={o.id} className={o.archivedAt ? "muted" : ""}>
                <td>
                  <strong>{o.name}</strong> {o.archivedAt && <span className="tag">{tr("archived")}</span>}
                  <div className="muted small">
                    <code>{o.id}</code> · {o.runtimeNamespace ?? tr("per-department namespaces")}
                  </div>
                </td>
                <td data-label={tr("Template")} className="small">{o.templateId ?? "—"}</td>
                <td data-label={tr("Owner")} className="small">{o.owner?.displayName ?? "—"}</td>
                <td data-label={tr("Agents")} className="small">{o.agents}</td>
                <td data-label={tr("People")} className="small">{o.members}</td>
                <td>
                  <div className="btn-row">
                    {member.has(o.id) && !o.archivedAt && (
                      <button type="button" onClick={() => onOpen(o.id)}>
                        {tr("Open")}
                      </button>
                    )}
                    {o.archivedAt ? (
                      <button type="button" onClick={() => void run(() => api("PATCH", `/api/admin/orgs/${o.id}`, { archived: false }))}>
                        {tr("Restore")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="danger"
                        onClick={async () => {
                          if (await askConfirm(`Archive ${o.name}? Its runtimes stop and its members lose access until you restore it.`, { danger: true })) {
                            void run(() => api("PATCH", `/api/admin/orgs/${o.id}`, { archived: true }));
                          }
                        }}
                      >
                        {tr("Archive")}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="btn-row" style={{ marginTop: 16 }}>
        <button type="button" className="primary" onClick={() => setCreating(true)}>
          {tr("New world")}
        </button>
      </div>
      {creating && (
        <CreateWorldDialog
          account={account}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            void load();
            onChanged();
            if (id) onOpen(id);
          }}
        />
      )}
    </Modal>
  );
}
