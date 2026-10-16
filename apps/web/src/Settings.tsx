import { useState } from "react";
import { api } from "./api.ts";
import { browserLang, type Lang, langChoice, languageLabel, LANGUAGES, setLang, t } from "./i18n.ts";
import { Modal } from "./ui.tsx";
import { ConnectorsSettings } from "./Connectors.tsx";

const nameOf = (id: Lang) => LANGUAGES.find((l) => l.id === id)!.name;

/** Per-person interface language, and the organization's template language (owner only). */
export function SettingsDialog({ org, kernel, lead, owner, onClose }: { org: { name: string; language: Lang; term?: string }; kernel?: { worldEdits: "approve" | "auto"; approver?: "owner" | "lead" }; lead?: string; owner: boolean; onClose: () => void }) {
  const [worldEdits, setWorldEdits] = useState(kernel?.worldEdits ?? "approve");
  const [approver, setApprover] = useState(kernel?.approver ?? "owner");
  const [kernelError, setKernelError] = useState("");
  const saveKernel = async (change: { worldEdits?: "approve" | "auto"; approver?: "owner" | "lead" }) => {
    const before = { worldEdits, approver };
    if (change.worldEdits) setWorldEdits(change.worldEdits);
    if (change.approver) setApprover(change.approver);
    setKernelError("");
    try {
      await api("PUT", "/api/kernel", change);
    } catch (e) {
      setWorldEdits(before.worldEdits);
      setApprover(before.approver);
      setKernelError((e as Error).message);
    }
  };
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
          <h3>{languageLabel(org.term)}</h3>
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
        {saved && <p className="small ok" role="status">{org.term ? t("{term} language set to {lang}", { term: t(org.term), lang: nameOf(saved) }) : t("Template language set to {lang}", { lang: nameOf(saved) })}</p>}
        {error && <p className="error small" role="alert">{error}</p>}
      </section>
      <section className="settings-section">
        <label htmlFor="world-edits">
          <h3>{t("Agents editing the world")}</h3>
        </label>
        <p className="muted small">
          {t("Agents allowed to design can change rooms, objects and art. Agents without that permission can only propose changes, which always wait for you.")}
        </p>
        <select id="world-edits" value={worldEdits} disabled={!owner} onChange={(e) => void saveKernel({ worldEdits: e.target.value as "approve" | "auto" })}>
          <option value="approve">{t("Ask me to approve every change")}</option>
          <option value="auto">{t("Designers apply changes directly")}</option>
        </select>
      </section>
      <section className="settings-section">
        <label htmlFor="approver">
          <h3>{t("Who approves agents' requests")}</h3>
        </label>
        <p className="muted small">
          {t("Some things agents ask for need an approval (cancelling work, changing the office, settings). You can leave them to the agent at the top of the organization: it decides others' requests in a task of its own, and its own go through at once. Changes to the code always come to you.")}
        </p>
        <select id="approver" value={approver} disabled={!owner} onChange={(e) => void saveKernel({ approver: e.target.value as "owner" | "lead" })}>
          <option value="owner">{t("Me")}</option>
          <option value="lead">{lead ? t("{name}, the agent at the top", { name: lead }) : t("The agent at the top")}</option>
        </select>
        {!owner && <p className="muted small">{t("Only the owner can change it.")}</p>}
        {kernelError && <p className="error small" role="alert">{kernelError}</p>}
      </section>
      <ConnectorsSettings owner={owner} />
    </Modal>
  );
}
