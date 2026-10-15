/**
 * Scale-weight plausibility filter — shared by the shot recorder and the
 * flow-hold driver so both consume the frame's scale weight through ONE
 * heuristic, not two divergent measuring paths.
 *
 * During a real brew the weight rises only a few grams between ~250 ms samples.
 * A large jump or drop is a sensor glitch — e.g. the cup lifted off the scale,
 * where the machine reports a wrapped-positive value for the real negative
 * reading. Outside the start grace such a reading is rejected and the caller
 * carries the last plausible weight forward. During grace nothing is rejected:
 * the machine tares the scale a moment after the brew starts, and that
 * legitimate drop back to ~0 would otherwise be mistaken for a glitch (root
 * cause of the latched-high bogus yields on shots #71/#75/#77).
 */

/** Max plausible rise (g) between samples before a reading counts as a glitch. */
const WEIGHT_JUMP_TOL_G = 15;
/** Max plausible drop (g) between samples before a reading counts as a glitch. */
const WEIGHT_DROP_TOL_G = 2;

/**
 * Glitch-filter a non-null scale reading. Returns `raw` when it is a plausible
 * successor to `last` (also during grace, or when there is no prior reading),
 * otherwise returns `last` (carry forward). Callers own the `last` state and
 * should set it to the returned value.
 */
export function plausibleScaleWeight(
  raw: number,
  last: number | null,
  inGrace: boolean,
): number {
  if (
    !inGrace &&
    last !== null &&
    (raw < last - WEIGHT_DROP_TOL_G || raw > last + WEIGHT_JUMP_TOL_G)
  ) {
    return last; // implausible → carry forward
  }
  return raw;
}

/**
 * Nachlauf: groesster plausibler Anstieg je Messschritt (~370 ms).
 *
 * Im Nachlauf faellt nur noch Restkaffee und Tropfen. WEIGHT_JUMP_TOL_G (15 g)
 * ist fuer den laufenden Bezug gedacht und liess dort einen Griff an die Tasse
 * durch: Bezug 235 sprang in einem Schritt von 25,1 auf 36,4 g, und genau das
 * wurde Endgewicht und Kalibrier-Eingang.
 *
 * Gemessen ueber alle Nachlaeufe (2026-09-26, 1.112 Schritte): Mittel 0,1 g;
 * echter Restfluss direkt nach dem Stopp bis 1,2 g (Bezug 146, 191, erste
 * 0,4 s); eindeutige Griffe ab 2,4 g. 2,0 g trennt beides — dieselbe Grenze wie
 * WEIGHT_DROP_TOL_G fuer den Abfall. Ein erster Entwurf mit 1,0 g haette echten
 * Restfluss abgeschnitten.
 */
export const POST_BREW_RISE_TOL_G = 2.0;

/**
 * Stoerung im Nachlauf? Liefert den Sprung (g, vorzeichenbehaftet), wenn der
 * rohe Wert gegenueber dem letzten plausiblen um mehr als POST_BREW_RISE_TOL_G
 * steigt oder um mehr als WEIGHT_DROP_TOL_G faellt — sonst null.
 */
export function postBrewDisturbance(raw: number | null, last: number | null): number | null {
  if (raw === null || last === null) return null;
  const step = raw - last;
  if (step > POST_BREW_RISE_TOL_G || step < -WEIGHT_DROP_TOL_G) return step;
  return null;
}
