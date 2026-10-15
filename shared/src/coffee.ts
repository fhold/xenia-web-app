/**
 * Coffee/Roasting (Sorte/Röstung) shared helpers — §3.4b.
 *
 * Pure functions usable by both backend (API computed fields) and frontend.
 */

import type { Bean, BeanRating } from "./types.js";

const DAY_MS = 86_400_000;

/**
 * Effective age in days (§3.4b): calendar days since `roastDate` minus the
 * frozen duration. Frozen duration = (thawDate ?? now) − frozenDate, when
 * frozenDate is set; otherwise 0. While still frozen (frozenDate set, thawDate
 * null or stale) the frozen duration grows with `now`, so the effective age
 * "freezes" at the value it had on the freeze day. Clamped to ≥ 0.
 *
 * Returns null when there is no parseable roast date.
 */
export function computeEffectiveAgeDays(
  roastDate: string | null | undefined,
  frozenDate: string | null | undefined,
  thawDate: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!roastDate) return null;
  const roastMs = Date.parse(roastDate);
  if (Number.isNaN(roastMs)) return null;

  let frozenMs = 0;
  if (frozenDate) {
    const fz = Date.parse(frozenDate);
    if (!Number.isNaN(fz)) {
      const thaw = thawDate ? Date.parse(thawDate) : NaN;
      // Ein thawDate VOR dem frozenDate stammt aus einem früheren Zyklus — das
      // Modell hält nur ein Frozen/Thaw-Paar, ein erneutes Einfrieren überschreibt
      // also nur das frozenDate. Dann gilt die Bohne als noch eingefroren; ohne
      // diese Prüfung wäre die Frostdauer negativ und würde auf 0 geklemmt, das
      // Einfrieren fiele stillschweigend aus der Rechnung.
      const endMs = Number.isNaN(thaw) || thaw < fz ? now : thaw;
      frozenMs = Math.max(0, endMs - fz);
    }
  }

  const ageMs = Math.max(0, now - roastMs - frozenMs);
  return Math.floor(ageMs / DAY_MS);
}

/**
 * Restbestand einer Röstung: Anker minus die seither bezogene Dosis.
 *
 * Der Anker ist der von Hand gesetzte Restwert (`remainingG`, gültig ab
 * `remainingSetAt`); wurde nie korrigiert, ist die Beutelgrösse der Anker und
 * alle Bezüge zählen. `consumedG` liefert der Aufrufer — die Summe der Dosen
 * aller Brüh-Bezüge nach dem Anker.
 *
 * Bewusst NICHT bei 0 geklemmt: ein negativer Wert zeigt, dass mehr bezogen
 * wurde als der Beutel hergibt, und ist damit ein Hinweis auf eine falsche
 * Beutelgrösse oder eine fehlende Korrektur — kein Zustand, den man verstecken
 * sollte. Null nur, wenn es gar keinen Anker gibt.
 */
export function computeRemainingG(
  bagSizeG: number | null | undefined,
  remainingG: number | null | undefined,
  remainingSetAt: number | null | undefined,
  consumedG: number,
): number | null {
  const anchor = remainingSetAt != null ? remainingG : bagSizeG;
  if (anchor == null) return null;
  return Math.round((anchor - consumedG) * 10) / 10;
}

/**
 * Ist der Beutel aufgebraucht? Schwelle ist nicht 0, sondern die zuletzt
 * bezogene Dosis: was fuer keinen weiteren Bezug mehr reicht, ist praktisch
 * leer. Ohne bekannte Dosis bleibt es bei "nichts mehr uebrig".
 *
 * Ohne Beutelgroesse (und ohne manuellen Anker) gibt es keinen Restbestand und
 * damit auch kein Signal — solche Roestungen melden sich nie.
 */
export function isStockDepleted(
  remainingG: number | null | undefined,
  lastDoseG: number | null | undefined,
): boolean {
  if (remainingG == null) return false;
  if (lastDoseG == null || lastDoseG <= 0) return remainingG <= 0;
  return remainingG < lastDoseG;
}

/** Effective rating (§3.4b): the bean (charge) override, else the coffee rating. */
export function effectiveRating(
  beanRating: BeanRating | null | undefined,
  coffeeRating: BeanRating | null | undefined,
): BeanRating | null {
  return beanRating ?? coffeeRating ?? null;
}

/**
 * Andere aktive Röstungen derselben Sorte, wenn `id` gerade aktiv gesetzt
 * wird — die fragt die App dann ab (archivieren / nur inaktiv / beide lassen).
 * Archivierte zählen nicht: die sind nie Bezugsquelle.
 */
export function activeSiblings(roastings: Bean[], id: number): Bean[] {
  return roastings.filter((b) => b.id !== id && b.isActive && b.status !== "archived");
}

/**
 * Ist „nur inaktiv setzen" die naheliegende Antwort? Ja, wenn alle anderen
 * eingefroren sind — ein Beutel im Froster ist pausiert, nicht aufgebraucht.
 * Sonst ist es „archivieren": die alte Tüte ist meist leer, wenn die neue
 * aufgeht.
 */
export function preferDeactivate(siblings: Bean[]): boolean {
  return siblings.length > 0 && siblings.every((b) => b.status === "frozen");
}
