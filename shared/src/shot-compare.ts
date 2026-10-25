/**
 * Bezuege vergleichen — der reine Teil: Kennzahlen aus den Messpunkten und
 * der Versatz, mit dem zwei Bezuege am ersten Tropfen uebereinander liegen.
 *
 * Ø Druck wie im Bezugs-Detail (ueber alle Messpunkte), damit beide Ansichten
 * dieselbe Zahl zeigen. Neu ist der Fluss ab dem ersten Tropfen:
 * Gewichtszunahme vom ersten Tropfen bis zum Ende des Bruehens ÷ Zeit. Der
 * Anlauf (Preinfusion, Bloom) zaehlt nicht mit — sonst haengt die Zahl an
 * seiner Laenge statt am Puck.
 */

import { firstDropS } from "./stage-strip.js";
import type { Sample } from "./types.js";

export type CompareSample = Pick<Sample, "elapsedMs" | "pressureBar" | "weightG" | "phase">;

/** Darunter ist ein Mittelwert ueber den Fluss nur Rauschen am Anfang und Ende. */
export const MIN_FLOW_SPAN_S = 3;

export interface ShotMetrics {
  /** Erster Tropfen (s), wie in der Stufenleiste; null ohne Gewicht. */
  firstDropS: number | null;
  /** Ende des Bruehens (s): Beginn des Nachlaufs, sonst der letzte Messpunkt. */
  brewEndS: number | null;
  /** Ø Fluss vom ersten Tropfen bis zum Ende des Bruehens (g/s). */
  extractionFlowGs: number | null;
  /** Ø Druck ueber alle Messpunkte (bar), wie im Bezugs-Detail. */
  avgPressureBar: number | null;
}

export function shotMetrics(samples: CompareSample[]): ShotMetrics {
  const empty: ShotMetrics = { firstDropS: null, brewEndS: null, extractionFlowGs: null, avgPressureBar: null };
  if (samples.length === 0) return empty;

  let sumP = 0, nP = 0;
  for (const s of samples) if (s.pressureBar !== null) { sumP += s.pressureBar; nP++; }

  const postBrew = samples.find((s) => s.phase === "post_brew");
  const brewEndS = (postBrew ?? samples[samples.length - 1]!).elapsedMs / 1000;
  const pts = samples.map((s) => ({ t: s.elapsedMs / 1000, weight: s.weightG }));
  const drop = firstDropS(pts);

  let extractionFlowGs: number | null = null;
  if (drop !== null && brewEndS - drop >= MIN_FLOW_SPAN_S) {
    const w0 = pts.find((p) => p.t === drop)!.weight!;
    let w1: number | null = null;
    for (const p of pts) if (p.t <= brewEndS && p.weight !== null) w1 = p.weight;
    if (w1 !== null && w1 > w0) extractionFlowGs = (w1 - w0) / (brewEndS - drop);
  }

  return { firstDropS: drop, brewEndS, extractionFlowGs, avgPressureBar: nP > 0 ? sumP / nP : null };
}

/**
 * Versatz (s) je Bezug, damit beide ersten Tropfen auf derselben Zeit liegen.
 * Verschoben wird der mit dem frueheren Tropfen nach rechts — nie einer nach
 * links, sonst fiele sein Anfang aus dem Diagramm. null, wenn einem der Tropfen fehlt.
 */
export function alignAtFirstDrop(dropA: number | null, dropB: number | null): { a: number; b: number } | null {
  if (dropA === null || dropB === null) return null;
  return { a: Math.max(0, dropB - dropA), b: Math.max(0, dropA - dropB) };
}

// ---------------------------------------------------------------------------
// Beide Bezuege auf ein gemeinsames Zeitraster
// ---------------------------------------------------------------------------

export interface CurvePoint {
  t: number;
  pressure: number | null;
  flow: number | null;
  weight: number | null;
}

export interface MergedPoint extends CurvePoint {
  bPressure: number | null;
  bFlow: number | null;
  bWeight: number | null;
}

/** Laengere Luecken zwischen zwei Messpunkten bleiben Luecken (Waage weg, Aufzeichnung stockte). */
export const MAX_BRIDGE_S = 2;

/** Werte einer Reihe an aufsteigenden Zeiten — linear zwischen den Messpunkten, ausserhalb null. */
function valuesAt(points: { t: number; v: number | null }[], times: number[]): (number | null)[] {
  const pts = points.filter((p): p is { t: number; v: number } => p.v !== null);
  const out: (number | null)[] = [];
  let i = 0;
  for (const t of times) {
    while (i + 1 < pts.length && pts[i + 1]!.t <= t) i++;
    const p = pts[i];
    if (!p || t < p.t) { out.push(null); continue; }
    if (p.t === t) { out.push(p.v); continue; }
    const q = pts[i + 1];
    if (!q || q.t - p.t > MAX_BRIDGE_S) { out.push(null); continue; }
    out.push(p.v + ((q.v - p.v) * (t - p.t)) / (q.t - p.t));
  }
  return out;
}

/**
 * A und B auf alle Zeitpunkte beider Bezuege. Jeder Punkt traegt beide Werte —
 * so fahren Cursor und Tooltip an beiden Kurven entlang. Die eingefuegten
 * Punkte liegen auf den Geraden zwischen zwei Messpunkten, die Linien sehen
 * also aus wie vorher.
 */
export function mergeCompare(a: CurvePoint[], b: CurvePoint[]): MergedPoint[] {
  const times = [...new Set([...a, ...b].map((p) => p.t))].sort((x, y) => x - y);
  const col = (src: CurvePoint[], key: "pressure" | "flow" | "weight") => valuesAt(src.map((p) => ({ t: p.t, v: p[key] })), times);
  const [ap, af, aw, bp, bf, bw] = [col(a, "pressure"), col(a, "flow"), col(a, "weight"), col(b, "pressure"), col(b, "flow"), col(b, "weight")];
  return times.map((t, k) => ({
    t, pressure: ap[k]!, flow: af[k]!, weight: aw[k]!, bPressure: bp[k]!, bFlow: bf[k]!, bWeight: bw[k]!,
  }));
}
