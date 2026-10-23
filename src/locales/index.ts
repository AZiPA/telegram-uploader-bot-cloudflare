import { en } from "./en";
import { fa } from "./fa";

export type TranslationKey = keyof typeof en;
export type SupportedLanguage = "en" | "fa";
export const DEFAULT_LANGUAGE: SupportedLanguage = "en";

const DICTIONARIES: Record<SupportedLanguage, typeof en> = { en, fa };

export function t(lang: string | undefined, key: TranslationKey, params?: Record<string, string | number>): string {
  const selectedLang: SupportedLanguage = lang === "fa" ? "fa" : DEFAULT_LANGUAGE;
  const dict = DICTIONARIES[selectedLang] || DICTIONARIES[DEFAULT_LANGUAGE];
  let text = (dict[key] as string) || (en[key] as string) || key;

  if (params) {
    for (const [paramKey, paramVal] of Object.entries(params)) {
      // split/join: a string replacement would treat `$&` / `$$` in user text as patterns.
      text = text.split(`{${paramKey}}`).join(String(paramVal));
    }
  }
  return text;
}

export function getLocalizedOrdinals(lang: string | undefined): string[] {
  const selectedLang: SupportedLanguage = lang === "fa" ? "fa" : DEFAULT_LANGUAGE;
  return DICTIONARIES[selectedLang]?.ordinals || en.ordinals;
}