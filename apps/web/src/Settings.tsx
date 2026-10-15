import { useState } from "react";
import { api } from "./api.ts";
import { type Lang, langChoice, LANGUAGES, setLang, t } from "./i18n.ts";
import { Modal } from "./ui.tsx";

const browserLang = (): Lang => (navigator.language?.toLowerCase().startsWith("vi") ? "vi" : "en");
const nameOf = (id: Lang) => LANGUAGES.find((l) => l.id === id)!.name;

/** Per-person interface language, and the organization's template language (owner only). */
export function SettingsDialog({ org, owner, onClose }: { org: { name: string; language: Lang }; owner: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<Lang | null>(null);
  const setTemplateLanguage = async (language: Lang) => {
    setBusy(true);
    setError("");
    try {
      await api("PUT", "/api/language", { language });
      setSaved(language);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const current = saved ?? org.language;
  return (
    <Modal title={t("Settings")} onClose={onClose}>
      <section className="settings-section">
        <label htmlFor="system-language">
          <h3>{t("System language")}</h3>
        </label>
        <p className="muted small">{t("Menus and screens, for you in this browser.")}</p>
        <select id="system-language" value={langChoice} onChange={(e) => setLang(e.target.value as Lang | "auto")}>
          <option value="auto">{t("Follow the browser ({lang})", { lang: nameOf(browserLang()) })}</option>
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </section>
      <section className="settings-section">
        <label htmlFor="template-language">
          <h3>{t("Template language")}</h3>
        </label>
        <p className="muted small">
          {t(
            "The language {org} works in. Agents write reports, team messages and deliverables in it from their next task, chats default to it, and names from the template (departments, rooms, objects…) switch to it. Names you wrote yourself stay as they are.",
            { org: org.name },
          )}
        </p>
        <select id="template-language" value={current} disabled={!owner || busy} onChange={(e) => void setTemplateLanguage(e.target.value as Lang)}>
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        {!owner && <p className="muted small">{t("Only the owner can change it.")}</p>}
        {saved && <p className="small ok" role="status">{t("Template language set to {lang}", { lang: nameOf(saved) })}</p>}
        {error && <p className="error small" role="alert">{error}</p>}
      </section>
    </Modal>
  );
}
