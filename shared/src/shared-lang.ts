/**
 * Sprache fuer Texte, die im gemeinsamen Code entstehen (Kurvenbeschriftungen,
 * Decent-Tabelle, Skript-Hilfe, Fehlermeldungen …). Das Frontend setzt sie beim
 * Start und bei jedem Sprachwechsel (i18n/index.ts); das Backend je Anfrage aus
 * dem Cookie des Geraets (backend/src/lib/request-lang.ts) oder per withSharedLang.
 * Standard Deutsch — Tests und Aufrufe ohne Anfrage bleiben unveraendert.
 */

export type SharedLang = "de" | "en";

let current: SharedLang = "de";

/** Backend: Sprache der laufenden Anfrage; undefined = keine Anfrage oder kein Cookie. */
let requestLang: (() => SharedLang | undefined) | null = null;

/** Sprache, die withSharedLang fuer die Dauer eines Aufrufs vorgibt. */
let forced: SharedLang | null = null;

export function setSharedLang(lang: SharedLang): void {
  current = lang;
}

export function setRequestLangSource(source: (() => SharedLang | undefined) | null): void {
  requestLang = source;
}

export function sharedLang(): SharedLang {
  return forced ?? requestLang?.() ?? current;
}

/** Text in der aktuellen Sprache: L("Fluss halten", "Hold flow"). */
export function L(de: string, en: string): string {
  return sharedLang() === "en" ? en : de;
}

/** `fn` in dieser Sprache ausfuehren und danach zuruecksetzen (synchron, fuer Backend-Anfragen). */
export function withSharedLang<T>(lang: SharedLang, fn: () => T): T {
  const prev = forced;
  forced = lang;
  try {
    return fn();
  } finally {
    forced = prev;
  }
}
