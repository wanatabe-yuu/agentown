import { useEffect, useState } from "react";
import type { World } from "@agentown/core/world";
import { api } from "./api.ts";
import { t } from "./i18n.ts";

type Connector = { id: string; name: string; url: string; description: string | null; approval: "ask" | "auto"; credential: { header: string } | null };

/**
 * The world's connectors (MCP servers its template brought, or a designer
 * added): whether agents' calls wait for approval, and their credential, which
 * only the owner sets and nobody sees again.
 */
export function ConnectorsSettings({ owner }: { owner: boolean }) {
  const [list, setList] = useState<Connector[] | null>(null);
  const [error, setError] = useState("");
  const load = () => api<{ connectors: Connector[] }>("GET", "/api/connectors").then((r) => setList(r.connectors)).catch((e) => setError((e as Error).message));
  useEffect(() => void load(), []);
  const setApproval = async (id: string, approval: "ask" | "auto") => {
    setError("");
    try {
      const cur = await api<{ revision: number; world: World }>("GET", "/api/world");
      const c = cur.world.connectors[id]!;
      await api("PUT", "/api/world", { revision: cur.revision, world: { ...cur.world, connectors: { ...cur.world.connectors, [id]: { ...c, approval } } } });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="settings-section">
      <h3>{t("Connectors")}</h3>
      <p className="muted small">{t("Outside services (MCP servers) that come with this world. Agents call their tools; each call waits for your approval unless the connector runs on its own.")}</p>
      {error && <p className="error small" role="alert">{error}</p>}
      {list === null ? (
        <p className="muted small">{t("Loading…")}</p>
      ) : !list.length ? (
        <p className="muted small">{t("This world has no connectors. A template, or someone who designs the world, adds them under connectors.")}</p>
      ) : (
        <ul className="connector-list">
          {list.map((c) => (
            <ConnectorRow key={c.id} c={c} owner={owner} onApproval={(a) => void setApproval(c.id, a)} onChanged={() => void load()} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ConnectorRow({ c, owner, onApproval, onChanged }: { c: Connector; owner: boolean; onApproval: (a: "ask" | "auto") => void; onChanged: () => void }) {
  const [value, setValue] = useState("");
  const [header, setHeader] = useState(c.credential?.header ?? "Authorization");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setNote(null);
    try {
      setNote({ ok: true, text: await fn() });
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  // A bare token under Authorization is meant as a bearer token.
  const secret = () => (header.toLowerCase() === "authorization" && !/\s/.test(value.trim()) ? `Bearer ${value.trim()}` : value.trim());
  return (
    <li className="connector">
      <div className="connector-head">
        <b>{c.name}</b>
        <span className={`pill pill-${c.credential ? "good" : "neutral"}`}>{c.credential ? t("Connected") : t("No credential")}</span>
      </div>
      <span className="muted small connector-url">{c.url}</span>
      {c.description && <span className="small">{c.description}</span>}
      <label className="connector-field">
        <span className="small">{t("Agents' calls")}</span>
        <select value={c.approval} disabled={!owner} onChange={(e) => onApproval(e.target.value as "ask" | "auto")}>
          <option value="ask">{t("Ask me every time")}</option>
          <option value="auto">{t("Run on their own")}</option>
        </select>
      </label>
      {owner && (
        <form
          className="connector-cred"
          onSubmit={(e) => {
            e.preventDefault();
            if (!value.trim()) return;
            void run(async () => {
              await api("PUT", `/api/connectors/${encodeURIComponent(c.id)}/credential`, { header: header.trim() || "Authorization", value: secret() });
              setValue("");
              onChanged();
              return t("Saved. It is never shown again.");
            });
          }}
        >
          <input className="connector-header" value={header} onChange={(e) => setHeader(e.target.value)} aria-label={t("Header")} spellCheck={false} />
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={c.credential ? t("Replace the token") : t("Token or API key")} aria-label={t("Token")} autoComplete="off" />
          <button type="submit" className="primary" disabled={busy || !value.trim()}>
            {t("Save")}
          </button>
        </form>
      )}
      <div className="btn-row">
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          const r = await api<{ tools: Array<{ name: string }> }>("GET", `/api/connectors/${encodeURIComponent(c.id)}/tools`);
          return t("{n} tools: {names}", { n: r.tools.length, names: r.tools.slice(0, 8).map((x) => x.name).join(", ") + (r.tools.length > 8 ? "…" : "") });
        })}>
          {t("Test")}
        </button>
        {owner && c.credential && (
          <button type="button" className="link" disabled={busy} onClick={() => void run(async () => {
            await api("DELETE", `/api/connectors/${encodeURIComponent(c.id)}/credential`);
            onChanged();
            return t("Credential removed.");
          })}>
            {t("Remove credential")}
          </button>
        )}
      </div>
      {note && <p className={`small ${note.ok ? "ok" : "error"}`} role="status">{note.text}</p>}
    </li>
  );
}
