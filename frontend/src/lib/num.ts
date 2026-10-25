/**
 * Dezimaltrennzeichen der Oberflaechensprache: Komma auf Deutsch, Punkt auf
 * Englisch (Flavio 22.10.). Nur fuer die Anzeige — Eingaben nehmen beides.
 */

import { getCurrentLanguage } from "../i18n/index.js";

export function dec(s: string): string {
  return getCurrentLanguage() === "de" ? s.replace(".", ",") : s;
}
