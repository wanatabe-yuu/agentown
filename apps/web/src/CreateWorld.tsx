import { useEffect, useState } from "react";
import { type Lang, lang, languageLabel, LANGUAGES, t as tr } from "./i18n.ts";
import { api } from "./api.ts";
import type { Account } from "./types.ts";
import { Modal } from "./ui.tsx";

/** How to write a world by hand, and how to publish one. */
export const WORLD_DOCS = "https://agentown.site/worlds/";

interface TemplateRow {
  id: string;
  name: string;
  description: string;
  term?: string;
  builtIn?: boolean;
  departments: string[];
}
interface MarketWorld {
  id: string;
  name: string;
  description: string;
  author: string;
  repo?: string;
  departments: string[];
  official: boolean;
  verified: boolean;
  /** Its cover first, then screenshots. */
  images?: string[];
  stats?: { departments?: number; agents?: number; rooms?: number; objects?: number };
  assets?: Array<{ path: string; size: number }>;
}
/** A card: a template here (built in) or a world on the marketplace, with what the marketplace knows of it. */
interface Card {
  key: string;
  name: string;
  description: string;
  departments: string[];
  builtIn: boolean;
  official: boolean;
  verified: boolean;
  author?: string;
  repo?: string;
  images: string[];
  stats?: MarketWorld["stats"];
  art: number;
  use: () => void;
}
interface AccountRow {
  id: string;
  displayName: string;
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

/**
 * A new world (organization): pick a template from the marketplace or upload one,
 * then name it. `onCreated` gets the new world's id when the admin belongs to it.
 */
export function CreateWorldDialog({ account, onClose, onCreated }: { account: Account; onClose: () => void; onCreated: (id: string | null) => void }) {
  const [tab, setTab] = useState<"marketplace" | "upload">("marketplace");
  const [picked, setPicked] = useState<TemplateRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={picked ? tr("New world: {name}", { name: picked.name }) : tr("Create a new world")} onClose={onClose} wide>
      {error && <p className="error">{error}</p>}
      {picked ? (
        <NameWorld account={account} template={picked} busy={busy} run={run} onBack={() => setPicked(null)} onCreated={onCreated} />
      ) : (
        <>
          <nav className="tabs" role="tablist">
            {(["marketplace", "upload"] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                {t === "marketplace" ? tr("Marketplace") : tr("Upload your world")}
              </button>
            ))}
          </nav>
          {tab === "marketplace" ? <MarketplaceTab busy={busy} run={run} onPick={setPicked} /> : <UploadTab busy={busy} run={run} onPick={setPicked} />}
        </>
      )}
    </Modal>
  );
}

type Run = (fn: () => Promise<unknown>) => Promise<void>;

function MarketplaceTab({ busy, run, onPick }: { busy: boolean; run: Run; onPick: (t: TemplateRow) => void }) {
  const [builtIn, setBuiltIn] = useState<TemplateRow[]>([]);
  const [market, setMarket] = useState<{ enabled: boolean; worlds: MarketWorld[] } | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "official" | "verified">("all");
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    api<{ templates: TemplateRow[] }>("GET", "/api/templates").then((r) => setBuiltIn(r.templates.filter((t) => t.builtIn))).catch(() => {});
    api<{ enabled: boolean; worlds: MarketWorld[] }>("GET", "/api/marketplace").then(setMarket).catch((e) => setMarketError((e as Error).message));
  }, []);

  const install = (w: MarketWorld) => run(async () => onPick(await api<TemplateRow>("POST", "/api/marketplace/install", { id: w.id })));
  const listed = market?.worlds ?? [];
  // A built-in template the marketplace also lists shows the marketplace's pictures; it is used from here.
  const cards: Card[] = [
    ...builtIn.map((t): Card => {
      const m = listed.find((w) => w.id === t.id);
      return { key: `t:${t.id}`, name: t.name, description: t.description, departments: t.departments, builtIn: true, official: true, verified: true, author: "Agentown", repo: m?.repo, images: m?.images ?? [], stats: m?.stats, art: m?.assets?.length ?? 0, use: () => onPick(t) };
    }),
    ...listed.filter((w) => !builtIn.some((t) => t.id === w.id)).map((w): Card => ({
      key: `m:${w.id}`, name: w.name, description: w.description, departments: w.departments, builtIn: false, official: w.official, verified: w.verified,
      author: w.author, repo: w.repo, images: w.images ?? [], stats: w.stats, art: w.assets?.length ?? 0, use: () => void install(w),
    })),
  ];
  const q = query.trim().toLowerCase();
  const shown = cards.filter((c) => (!q || [c.name, c.description, c.author ?? "", ...c.departments].some((s) => s.toLowerCase().includes(q))) && (filter === "all" || (filter === "official" ? c.official : c.verified)));
  const card = cards.find((c) => c.key === open);
  if (card) return <WorldDetails card={card} busy={busy} onBack={() => setOpen(null)} />;

  return (
    <>
      <div className="form-row" style={{ marginTop: 12 }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr("Search worlds")} aria-label={tr("Search worlds")} />
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label={tr("Show")}>
          <option value="all">{tr("All worlds")}</option>
          <option value="official">{tr("Official")}</option>
          <option value="verified">{tr("Verified")}</option>
        </select>
      </div>
      <div className="world-cards">
        {shown.map((c) => (
          <button key={c.key} type="button" className="world-card" onClick={() => setOpen(c.key)} aria-label={tr("About {name}", { name: c.name })}>
            <span className="world-cover">{c.images[0] ? <img src={c.images[0]} alt="" loading="lazy" /> : <span aria-hidden>{c.name.slice(0, 1)}</span>}</span>
            <span className="world-card-body">
              <strong>{c.name}</strong>
              <span className="world-tags">
                {c.builtIn && <span className="tag">{tr("built in")}</span>}
                <span className="tag">{c.official ? tr("Official") : c.verified ? tr("Verified") : tr("Unverified")}</span>
              </span>
              <span className="muted small world-card-desc">{c.description}</span>
            </span>
          </button>
        ))}
      </div>
      {marketError && <p className="muted small">{tr("The marketplace is not reachable right now: {error}", { error: marketError })}</p>}
      {market && !market.enabled && <p className="muted small">{tr("The marketplace is turned off on this install.")}</p>}
      {!shown.length && <p className="muted small">{tr("No marketplace world matches.")}</p>}
    </>
  );
}

/** One world: its pictures, what it holds, who made it, and using it. */
function WorldDetails({ card, busy, onBack }: { card: Card; busy: boolean; onBack: () => void }) {
  const [big, setBig] = useState(0);
  const st = card.stats;
  return (
    <div className="world-details">
      {card.images.length > 0 ? (
        <>
          <img className="world-shot" src={card.images[big]} alt={tr("{name}, picture {n}", { name: card.name, n: big + 1 })} />
          {card.images.length > 1 && (
            <div className="world-thumbs">
              {card.images.map((src, i) => (
                <button key={src} type="button" className={i === big ? "active" : ""} onClick={() => setBig(i)} aria-label={tr("Picture {n}", { n: i + 1 })}>
                  <img src={src} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="muted small">{tr("No pictures of this world yet.")}</p>
      )}
      <h3>
        {card.name} <span className="tag">{card.official ? tr("Official") : card.verified ? tr("Verified") : tr("Unverified")}</span>
      </h3>
      <p>{card.description}</p>
      {st && (
        <p className="muted small">
          {[
            st.departments !== undefined && tr("{n} departments", { n: st.departments }),
            st.agents !== undefined && tr("{n} agents to start", { n: st.agents }),
            st.rooms !== undefined && tr("{n} rooms", { n: st.rooms }),
            st.objects !== undefined && tr("{n} objects", { n: st.objects }),
            card.art > 0 && tr("{n} art files", { n: card.art }),
          ].filter(Boolean).join(" · ")}
        </p>
      )}
      {card.departments.length > 0 && <p className="muted small">{tr("Departments: {list}.", { list: card.departments.join(", ") })}</p>}
      <p className="muted small">
        {tr("By {author}", { author: card.author ?? "—" })}
        {card.repo && (
          <>
            {" · "}
            <a href={`https://github.com/${card.repo}`} target="_blank" rel="noreferrer">
              {card.repo}
            </a>
          </>
        )}
      </p>
      {!card.verified && <p className="muted small">{tr("Not reviewed: it may run scripts in viewers' browsers, open web pages on its computers and give its agents instructions. Read it before you use it.")}</p>}
      <div className="btn-row">
        <button type="button" className="ghost" onClick={onBack} disabled={busy}>
          {tr("Back")}
        </button>
        <button type="button" className="primary" onClick={card.use} disabled={busy}>
          {tr("Use this world")}
        </button>
      </div>
    </div>
  );
}

/** A file's bytes as base64 (in chunks: big models would overflow one call). */
async function base64(f: File) {
  const b = new Uint8Array(await f.arrayBuffer());
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A world bundle from picked files or a folder: its YAML, and the art as assets/NAME. */
async function bundleOf(files: File[]) {
  const rel = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
  const yamls = files.filter((f) => /\.ya?ml$/i.test(f.name));
  const yaml = yamls.find((f) => f.name === "agentown.world.yaml") ?? yamls[0];
  if (!yaml) throw new Error(tr("Pick the world's .yaml file (and its art)."));
  const art = files.filter((f) => f !== yaml && /\.(png|jpe?g|webp|glb)$/i.test(f.name) && !/(^|\/)(screenshots\/|cover\.)/.test(rel(f)));
  return { yaml: await yaml.text(), files: await Promise.all(art.map(async (f) => ({ path: `assets/${f.name}`, contentBase64: await base64(f) }))) };
}

function UploadTab({ busy, run, onPick }: { busy: boolean; run: Run; onPick: (t: TemplateRow) => void }) {
  const [library, setLibrary] = useState<TemplateRow[]>([]);
  useEffect(() => {
    api<{ templates: TemplateRow[] }>("GET", "/api/templates").then((r) => setLibrary(r.templates.filter((t) => !t.builtIn))).catch(() => {});
  }, []);
  return (
    <div className="form" style={{ marginTop: 12 }}>
      <p className="muted small">
        {tr("A world is a YAML file (departments, jobs, permissions, the first agents and the office) and, when it uses its own art, the files in assets/ beside it.")}{" "}
        <a href={WORLD_DOCS} target="_blank" rel="noreferrer">
          {tr("How to write a world")}
        </a>
      </p>
      {(["files", "folder"] as const).map((how) => (
        <label key={how}>
          {how === "files" ? tr("World file (.yaml) and its art") : tr("Or a whole world folder")}
          <input
            type="file"
            multiple
            {...(how === "folder" ? { webkitdirectory: "" } : { accept: ".yaml,.yml,text/yaml,.png,.jpg,.jpeg,.webp,.glb" })}
            disabled={busy}
            onChange={(e) => {
              const picked = [...(e.target.files ?? [])];
              e.target.value = "";
              if (picked.length) void run(async () => onPick(await api<TemplateRow>("POST", "/api/templates", await bundleOf(picked))));
            }}
          />
        </label>
      ))}
      {library.length > 0 && (
        <>
          <h3>{tr("Your templates")}</h3>
          <div className="table-wrap">
            <table className="grid mobile-cards">
              <tbody>
                {library.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <strong>{t.name}</strong>
                      <div className="muted small">{t.description}</div>
                    </td>
                    <td>
                      <button type="button" disabled={busy} onClick={() => onPick(t)}>
                        {tr("Use")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function NameWorld({ account, template, busy, run, onBack, onCreated }: { account: Account; template: TemplateRow; busy: boolean; run: Run; onBack: () => void; onCreated: (id: string | null) => void }) {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [name, setName] = useState(template.name);
  const [id, setId] = useState(slug(template.name));
  const [idTouched, setIdTouched] = useState(false);
  const [language, setLanguage] = useState<Lang>(lang);
  const [owner, setOwner] = useState(account.user?.id ?? "");
  const [ownerName, setOwnerName] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  useEffect(() => {
    api<{ users: AccountRow[] }>("GET", "/api/admin/users").then((r) => setAccounts(r.users.filter((u) => !u.disabled))).catch(() => {});
  }, []);

  if (issued) {
    return (
      <div className="review-box">
        <h3>{tr("Owner token for {org}", { org: name })}</h3>
        <p className="muted small">{tr("Shown once. Send it to the new owner privately.")}</p>
        <div className="form-row">
          <input readOnly value={issued} aria-label={tr("Owner token")} className="mono" onFocus={(e) => e.target.select()} />
          <button type="button" onClick={() => void navigator.clipboard.writeText(issued)}>
            {tr("Copy")}
          </button>
          <button type="button" className="ghost" onClick={() => onCreated(null)}>
            {tr("Done")}
          </button>
        </div>
      </div>
    );
  }
  const create = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<{ org: { id: string }; ownerToken: string | null }>("POST", "/api/admin/orgs", {
        id,
        name,
        templateId: template.id,
        language,
        owner: owner ? { userId: owner } : { displayName: ownerName },
      });
      if (r.ownerToken) setIssued(r.ownerToken);
      else onCreated(owner === account.user?.id ? r.org.id : null);
    });
  };
  return (
    <form className="form" onSubmit={create}>
      <p className="muted small">
        {template.description} {template.departments.length > 0 && tr("Departments: {list}.", { list: template.departments.join(", ") })}
      </p>
      <label>
        {languageLabel(template.term)}
        <select value={language} onChange={(e) => setLanguage(e.target.value as Lang)}>
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <small className="muted">{tr("Names from the template and the agents' working language.")}</small>
      </label>
      <div className="form-row">
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!idTouched) setId(slug(e.target.value));
          }}
          placeholder={tr("Name")}
          required
          maxLength={80}
          aria-label={tr("Name")}
        />
        <input
          value={id}
          onChange={(e) => {
            setId(e.target.value);
            setIdTouched(true);
          }}
          placeholder={tr("id (url, namespace)")}
          required
          pattern="[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?"
          maxLength={40}
          aria-label={tr("Organization id")}
          className="mono"
        />
      </div>
      <div className="form-row">
        <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label={tr("Owner")}>
          {accounts.map((u) => (
            <option key={u.id} value={u.id}>
              {tr("Owner: {name}", { name: u.displayName })}
              {u.id === account.user?.id ? tr(" (you)") : ""}
            </option>
          ))}
          <option value="">{tr("Owner: a new person…")}</option>
        </select>
        {!owner && <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder={tr("New owner's name")} required maxLength={60} aria-label={tr("New owner's name")} />}
      </div>
      <div className="btn-row">
        <button type="button" className="ghost" onClick={onBack} disabled={busy}>
          {tr("Back")}
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {tr("Create world")}
        </button>
      </div>
    </form>
  );
}
