/**
 * Template language: the language an organization works in. It decides which
 * language agents write in, the default language of chats, and the display
 * names the organization's template brought (departments, rooms, objects…).
 * Names are swapped only on exact matches, so anything the owner renamed stays.
 */
import { type Language, LANGUAGES } from "@agentown/core";
import de from "./locales/de.json" with { type: "json" };
import es from "./locales/es.json" with { type: "json" };
import fr from "./locales/fr.json" with { type: "json" };
import idn from "./locales/id.json" with { type: "json" };
import ja from "./locales/ja.json" with { type: "json" };
import ko from "./locales/ko.json" with { type: "json" };
import pt from "./locales/pt.json" with { type: "json" };
import ru from "./locales/ru.json" with { type: "json" };
import th from "./locales/th.json" with { type: "json" };
import vi from "./locales/vi.json" with { type: "json" };
import zh from "./locales/zh.json" with { type: "json" };

export { LANGUAGES, type Language };

export const LANGUAGE_NAME: Record<Language, string> = {
  en: "English", vi: "Vietnamese", zh: "Simplified Chinese", ja: "Japanese", ko: "Korean", es: "Spanish", fr: "French",
  de: "German", pt: "Portuguese", ru: "Russian", id: "Indonesian", th: "Thai",
};

/** Agents and personas default to this; a requester writing another language still gets answers in theirs. */
export const languageInstruction = (l: Language) =>
  l === "en" ? "" : `Work in ${LANGUAGE_NAME[l]}: write reports, team messages and deliverables in ${LANGUAGE_NAME[l]} unless the requester writes in another language or asks for one.`;

// English template names → their translations (locales/<id>.json). Proper names (people, pets) are left alone.
export const DICTS: Record<Language, Record<string, string>> = { en: {}, vi, zh, ja, ko, es, fr, de, pt, ru, id: idn, th };
const TEXT_FIELDS = new Set(["name", "title", "label"]);

/** The same document with template names moved from one language to another. */
export function translateNames<T>(doc: T, from: Language, to: Language): T {
  if (from === to) return doc;
  const toEn = Object.fromEntries(Object.entries(DICTS[from]).map(([en, x]) => [x, en]));
  const map = (s: string) => DICTS[to][toEn[s] ?? s] ?? toEn[s] ?? s;
  // Chat templates are keyed by title: their keys follow the titles they belong to.
  const walk = (v: unknown, parent = ""): unknown =>
    Array.isArray(v) ? v.map((x) => walk(x))
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [parent === "chatTemplates" ? map(k) : k, TEXT_FIELDS.has(k) && typeof x === "string" ? map(x) : walk(x, k)]))
    : v;
  return walk(doc) as T;
}
