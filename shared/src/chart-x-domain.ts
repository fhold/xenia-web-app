/**
 * Zeitachse des Bezugs-Diagramms — reine Berechnung der x-Grenzen.
 *
 * Zwei Arten, einen laufenden Bezug zu zeigen:
 *
 *   Schiebefenster (grow = false, bisheriges Verhalten)
 *     elapsed < windowS  → [0, windowS]
 *     elapsed >= windowS → xMin rueckt in slideStepS-Schritten nach:
 *       offset = floor((elapsed - windowS) / slideStepS) * slideStepS + slideStepS
 *       → [offset, offset + windowS]
 *     Nachteil: bei Bezuegen ueber windowS laeuft der Anfang — die Preinfusion —
 *     links aus dem Bild, genau dann, wenn man sie mit dem Druckaufbau
 *     vergleichen will.
 *
 *   Stauchende Achse (grow = true, wie bei Decent)
 *     [0, max(elapsed, GROW_FLOOR_S)] — die Kurve reicht immer bis zum rechten
 *     Rand, der ganze Bezug fuellt stets die ganze Flaeche und wird im Lauf
 *     gestaucht. Der Boden von 1 s gilt nur ganz am Anfang (eine Achse 0..0 ist
 *     nicht darstellbar). Das Diagramm setzt diese Grenzen ohne Animation:
 *     bei ~370-ms-Waagentakt liefe sie sonst ununterbrochen, und die Kurve
 *     ragte kurz ueber den Rand, bevor die Achse nachzieht.
 *
 * Nach dem Bezug (mode "ended" mit resizeOnEnd) zeigen beide den ganzen Bezug.
 * Die stauchende Achse tut das immer — "immer gefuellt" heisst ganzer Bezug,
 * der Zoom-Schalter spielt dort keine Rolle (Einstellungen blenden ihn aus).
 */

export const GROW_FLOOR_S = 1;

export interface XDomainArgs {
  /** Zeit des letzten Messpunkts in Sekunden. */
  elapsed: number;
  mode: "idle" | "brewing" | "ended";
  grow: boolean;
  windowS: number;
  slideStepS: number;
  resizeOnEnd: boolean;
  /** Ende der Soll-Kurve, falls eine gezeigt wird — sonst null. */
  overlayEndT: number | null;
}

export function chartXDomain(a: XDomainArgs): { min: number; max: number } {
  if (a.mode === "ended" && (a.resizeOnEnd || a.grow)) {
    // SO-1: das Soll-Ende einschliessen, damit der gehaltene Teil sichtbar ist.
    const end = a.overlayEndT !== null ? Math.max(a.elapsed, a.overlayEndT) : a.elapsed;
    return { min: 0, max: Math.ceil(end) + 2 };
  }
  if (a.grow) {
    return { min: 0, max: Math.max(a.elapsed, GROW_FLOOR_S) };
  }
  if (a.mode === "brewing" && a.elapsed >= a.windowS) {
    const offset =
      Math.floor((a.elapsed - a.windowS) / a.slideStepS) * a.slideStepS + a.slideStepS;
    return { min: offset, max: offset + a.windowS };
  }
  return { min: 0, max: a.windowS };
}

/**
 * Live-Kurve, die stetig waechst statt in Stufen.
 *
 * Die Messwerte kommen nicht gleichmaessig: eingestellt sind 250 ms, die
 * Maschine liefert im Mittel alle ~370 ms (gemessen 302–742 ms). Jeder neue
 * Punkt verlaengerte alle Kurven auf einen Schlag; dazwischen stand das
 * Kurvenende still, waehrend die Achse weiterlief — die Kurve wurde gestaucht
 * und sprang dann nach vorn.
 *
 * Jetzt laeuft eine Anzeige-Uhr LIVE_LAG_S hinter der echten Zeit her, und das
 * letzte Stueck jeder Kurve wird bis zu ihr linear zwischen den zwei Punkten
 * gezogen, die sie umschliessen. Solange der naechste Punkt innerhalb der
 * Verzoegerung eintrifft, gibt es immer zwei solche Punkte und die Kurve waechst
 * gleichmaessig. Kommt einer spaeter, bleibt sie kurz am letzten Punkt stehen
 * (keine Vorausschaetzung — die zeichnete bei jedem Wechsel Falsches).
 *
 * 0,5 s aus den echten Abstaenden: ueber 15 Bezuege (1.519 Abstaende) waren
 * 24 % laenger als 0,4 s, aber nur 2 % laenger als 0,5 s.
 *
 * Nur die Linie ist verzoegert. Die Zahlen ueber dem Diagramm, Stopp nach
 * Gewicht, Watchdog und Regelung arbeiten mit den echten Werten.
 */
export const LIVE_LAG_S = 0.5;

/** Zeitpunkt, bis zu dem live gezeichnet wird (Sekunden ab Bezugsbeginn). */
export function liveDisplayT(nowElapsedS: number): number {
  return Math.max(0, nowElapsedS - LIVE_LAG_S);
}

/**
 * Zeilen bis displayT, das letzte Stueck bis genau dorthin interpoliert.
 * `tipT` ist die Zeit des Kurvenendes — die rechte Kante der Achse.
 * Ein Wert, der an einer der zwei Seiten fehlt (null), bleibt im Endstueck null.
 */
export function trimToDisplayTime<T extends { t: number }>(
  rows: T[],
  displayT: number,
  keys: readonly (keyof T)[],
): { rows: T[]; tipT: number } {
  if (rows.length === 0) return { rows, tipT: 0 };
  let i = -1;
  while (i + 1 < rows.length && rows[i + 1]!.t <= displayT) i++;
  if (i < 0) return { rows: [], tipT: displayT };
  if (i === rows.length - 1) return { rows, tipT: rows[i]!.t };
  const a = rows[i]!;
  const b = rows[i + 1]!;
  const f = (displayT - a.t) / (b.t - a.t);
  const tip = { ...a, t: displayT } as T;
  for (const k of keys) {
    const va = a[k] as unknown;
    const vb = b[k] as unknown;
    (tip as Record<keyof T, unknown>)[k] =
      typeof va === "number" && typeof vb === "number" ? va + (vb - va) * f : null;
  }
  return { rows: [...rows.slice(0, i + 1), tip], tipT: displayT };
}

/**
 * Feste Sekundenmarken fuer die stauchende Achse. Mit tickCount rechnet das
 * Diagramm die Marken bei jeder Achsenaenderung neu und sie springen hin und
 * her; feste Schritte bleiben stehen und ruecken nur zusammen.
 */
export function fixedXTicks(max: number): number[] {
  const step = max <= 30 ? 5 : max <= 90 ? 10 : 30;
  const ticks: number[] = [];
  for (let t = 0; t <= max + 1e-9; t += step) ticks.push(t);
  return ticks;
}
