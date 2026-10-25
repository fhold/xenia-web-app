/**
 * Sprache fuer Texte, die im gemeinsamen Code entstehen (Kurvenbeschriftungen,
 * Decent-Tabelle, Skript-Hilfe …). Das Frontend setzt sie beim Start und bei
 * jedem Sprachwechsel (i18n/index.ts); das Backend fuer eine Anfrage per
 * withSharedLang. Standard Deutsch — Tests und Altaufrufe bleiben unveraendert.
 */

export type SharedLang = "de" | "en";

let current: SharedLang = "de";

export function setSharedLang(lang: SharedLang): void {
  current = lang;
}

export function sharedLang(): SharedLang {
  return current;
}

/** Text in der aktuellen Sprache: L("Fluss halten", "Hold flow"). */
export function L(de: string, en: string): string {
  return current === "en" ? en : de;
}

/** `fn` in dieser Sprache ausfuehren und danach zuruecksetzen (synchron, fuer Backend-Anfragen). */
export function withSharedLang<T>(lang: SharedLang, fn: () => T): T {
  const prev = current;
  current = lang;
  try {
    return fn();
  } finally {
    current = prev;
  }
}
