/**
 * Interface language. English strings are the keys; each other language is a
 * dictionary of them in locales/<id>.json, loaded before the app starts, so
 * anything not translated yet still reads in English. The language follows the
 * browser until the person picks one (kept in this browser only).
 */
export const LANGUAGES = [
  { id: "en", name: "English" },
  { id: "vi", name: "Tiếng Việt" },
  { id: "zh", name: "中文（简体）" },
  { id: "ja", name: "日本語" },
  { id: "ko", name: "한국어" },
  { id: "es", name: "Español" },
  { id: "fr", name: "Français" },
  { id: "de", name: "Deutsch" },
  { id: "pt", name: "Português" },
  { id: "ru", name: "Русский" },
  { id: "id", name: "Bahasa Indonesia" },
  { id: "th", name: "ไทย" },
] as const;
export type Lang = (typeof LANGUAGES)[number]["id"];

const KEY = "agentown.lang";
const known = (x: unknown): x is Lang => LANGUAGES.some((l) => l.id === x);

/** The browser's first language we have (zh-TW and zh-CN both read Chinese). */
export function browserLang(): Lang {
  const wanted = typeof navigator === "undefined" ? [] : [...(navigator.languages ?? []), navigator.language];
  for (const w of wanted) {
    const id = String(w ?? "").toLowerCase().split("-")[0];
    if (known(id)) return id;
  }
  return "en";
}

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (known(saved)) return saved;
  } catch {}
  return browserLang();
}

export const lang: Lang = initial();

/** What the person picked: a language, or "auto" to follow the browser. */
export const langChoice: Lang | "auto" = (() => {
  try {
    const saved = localStorage.getItem(KEY);
    if (known(saved)) return saved;
  } catch {}
  return "auto";
})();

export function setLang(next: Lang | "auto") {
  try {
    if (next === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {}
  location.reload();
}

/** "Café language": the template language, named after what the template calls its world. */
export const languageLabel = (term?: string) => (term ? t("{term} language", { term: t(term) }) : t("Template language"));

const DICTS = import.meta.glob<{ default: Record<string, string> }>("./locales/*.json");
let dict: Record<string, string> = {};

/** Load this person's language (call once, before rendering). */
export async function loadLang() {
  const load = DICTS[`./locales/${lang}.json`];
  if (lang !== "en" && load) dict = (await load()).default;
}

/** Translate; {name} placeholders are filled from vars. */
export function t(s: string, vars?: Record<string, string | number>): string {
  let out = dict[s] ?? s;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}
