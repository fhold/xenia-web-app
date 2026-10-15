/**
 * Lightweight i18n — no external library.
 *
 * Usage:
 *   import { t } from "../i18n/index.js";
 *   t("settings.chart.title")  // → "Diagramm" (de) or "Chart" (en)
 *
 *   // In components that need to re-render on language change:
 *   const { t } = useTranslation();
 */

import { useEffect, useState } from "react";
import { de } from "./de.js";
import { en } from "./en.js";

export type Language = "de" | "en";

const STORAGE_KEY = "xenia_lang";

const TRANSLATIONS: Record<Language, typeof de> = { de, en };

// ---------------------------------------------------------------------------
// Module-level state + pub/sub so all `useTranslation` instances react
// ---------------------------------------------------------------------------

let currentLang: Language = (() => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "en" ? "en" : "de";
  } catch {
    return "de";
  }
})();

type Listener = () => void;
const listeners = new Set<Listener>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getCurrentLanguage(): Language {
  return currentLang;
}

export function setLanguage(lang: Language): void {
  currentLang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ignore — storage unavailable
  }
  listeners.forEach((fn) => fn());
}

function getNestedValue(obj: Record<string, unknown>, path: string): string | undefined {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

/**
 * Translate a dot-notation path.
 * Falls back to German if the current language doesn't have the key.
 * Falls back to the raw path if even German doesn't have it.
 */
export function t(
  path: string,
  params?: Record<string, string | number>,
): string {
  const primary = getNestedValue(
    TRANSLATIONS[currentLang] as Record<string, unknown>,
    path,
  );
  const fallback =
    primary ??
    getNestedValue(TRANSLATIONS.de as Record<string, unknown>, path) ??
    path;
  // Interpolate {name} placeholders when params are supplied.
  return params
    ? fallback.replace(/\{(\w+)\}/g, (m, k: string) =>
        k in params ? String(params[k]) : m,
      )
    : fallback;
}

/**
 * Hook — components that use this will re-render when the language changes.
 */
export function useTranslation(): { t: typeof t; lang: Language } {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const listener: Listener = () => { forceUpdate((n) => n + 1); };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);

  return { t, lang: currentLang };
}
