/**
 * Wann gilt ein Bezug als bewertet?
 *
 * Die App hatte dafuer vier verschiedene Antworten — Detail-Modal, App-Reconcile,
 * Historienkarte und Bearbeiten-Dialog. Ergebnis: ein Bezug mit Channeling-Marke
 * und Mahlgrad-Hinweis stand in der Liste als "nicht bewertet", im Detail aber
 * als bewertet. Hier ist die eine Antwort.
 *
 * ⚠ Zwei Fragen, die bewusst getrennt bleiben:
 *   hasRating()   — liegt eine GESCHMACKS-/FEHLER-Einschaetzung vor? Die
 *                   Freitext-Notiz zaehlt NICHT: "Tasse zu lange stehen
 *                   gelassen" ist eine Notiz, kein Urteil ueber den Kaffee.
 *   isReviewed()  — hat der Benutzer den Nachbereitungs-Dialog ueberhaupt
 *                   erledigt? Dort zaehlt die Notiz mit, denn wer etwas
 *                   notiert hat, will nicht erneut gefragt werden.
 */

/** Die Felder, die eine Bewertung ausmachen — unabhaengig von Shot/ShotListItem. */
export interface RatedFields {
  rating: number | null;
  acidity: number | null;
  bitterness: number | null;
  extractionUnder: boolean;
  extractionOver: boolean;
  channeling: boolean;
  tasteTags: readonly string[] | null;
  grindNote: string | null;
}

/** Irgendeine Geschmacks- oder Fehler-Einschaetzung liegt vor. */
export function hasRating(s: RatedFields): boolean {
  return (
    s.rating !== null ||
    s.acidity !== null ||
    s.bitterness !== null ||
    s.extractionUnder ||
    s.extractionOver ||
    s.channeling ||
    (s.tasteTags?.length ?? 0) > 0 ||
    s.grindNote !== null
  );
}

/** Bewertet, aber ohne Sterne — die Anzeige braucht dafuer eine eigene Aussage. */
export function ratedWithoutStars(s: RatedFields): boolean {
  return s.rating === null && hasRating(s);
}

/**
 * Die gesetzten Extraktions-Marken, in Anzeigereihenfolge.
 *
 * ⚠ Eine leere Liste heisst "nicht beurteilt", NICHT "ausgewogen". Die drei
 * Schalter sind unabhaengig und keiner von ihnen bedeutet "geprueft und in
 * Ordnung" — es gibt keinen Schalter fuer diese Aussage. Die Detailansicht
 * leitete frueher "ausgewogen" daraus ab, dass under/over nicht gesetzt waren,
 * und uebersprang dabei Channeling: ein Bezug mit markiertem Channeling stand
 * damit als ausgewogen da, ebenso jeder nur mit Sternen bewertete Bezug.
 */
export function extractionMarks(s: RatedFields): ("under" | "over" | "channeling")[] {
  const out: ("under" | "over" | "channeling")[] = [];
  if (s.extractionUnder) out.push("under");
  if (s.extractionOver) out.push("over");
  if (s.channeling) out.push("channeling");
  return out;
}
