/**
 * Datumsangaben app-weit — eine Regel statt eigener Formatierer je Ansicht:
 *  - Röstdaten immer mit Jahr: eine Röstung kann älter als ein Jahr sein, und
 *    „28. Jan.“ sagt dann nicht, welcher Januar.
 *  - Bezugsdaten nur mit Jahr, wenn es nicht das laufende ist.
 *
 * `short` = „12. Jun.“ / „12. Jun. 2025“, `numeric` = „12.10.“ / „12.10.25“.
 */

import { getCurrentLanguage } from "../i18n/index.js";

export interface DayFormat {
  /** "auto" (Vorgabe): Jahr nur, wenn nicht das laufende. */
  year?: "always" | "auto";
  style?: "short" | "numeric";
  /** Uhrzeit dazu („17. Okt., 05:54“). */
  time?: boolean;
  /** Vorgabe: die eingestellte Sprache (de-DE / en-US). */
  locale?: string;
}

/** Tag und Monat, das Jahr nach Regel; "" bei ungültigem Datum. */
export function formatDay(value: Date | number | string, { year = "auto", style = "short", time = false, locale = getCurrentLanguage() === "en" ? "en-US" : "de-DE" }: DayFormat = {}): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const withYear = year === "always" || d.getFullYear() !== new Date().getFullYear();
  const opts: Intl.DateTimeFormatOptions = style === "numeric"
    ? { day: "2-digit", month: "2-digit", ...(withYear ? { year: "2-digit" } : {}) }
    : { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) };
  if (time) Object.assign(opts, { hour: "2-digit", minute: "2-digit" });
  return new Intl.DateTimeFormat(locale, opts).format(d);
}

/** Röstdatum: immer mit Jahr („28. Jan. 2025“). */
export const formatRoastDate = (value: Date | number | string): string => formatDay(value, { year: "always" });
