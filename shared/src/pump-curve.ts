/**
 * Pumpenkennlinie der Xenia als rechnerischer Durchflussmesser — die Maschine
 * misst keinen Zulauf (FW 4.133 hat den Flowmeter genullt), aber die Pumpe
 * verhaelt sich so gleichmaessig, dass er aus Leistung und Druck folgt:
 *
 *   P% = perBar · p + perMlS · Q + offset
 *
 * Gefittet auf 216 ruhige Messpunkte aus 26 Flow-Bezuegen (p < 7 bar, P ≤ 70 %):
 * im Bezug ~0,6 % Leistung Streuung (≈ 0,06 ml/s), zwischen Bezuegen ein fester
 * Versatz von ±1–3 %, den die Waage ueber die anschliessende Flussregelung
 * ausgleicht. Ueberschreibbar per Einstellung `pump_curve` (JSON), damit sie
 * sich nach einem Firmware-Update neu vermessen laesst.
 *
 * Ueber 7 bar gilt die Gerade nicht mehr: dort foerdert die Pumpe weniger. Alle
 * App-Bezuege mit ruhigen Abschnitten ueber 7 bar brauchten mehr Leistung, als
 * die Gerade sagt (0,4–6,4 %, Median 1,8 %; #298 2,2 % bei 8,65 bar) — als
 * Fehlmenge HIGH_PRESSURE_LOSS_MLS je bar ueber HIGH_PRESSURE_FROM_BAR.
 *
 * Hier liegt auch die Preinfusion, die darauf aufbaut (PreinfusionStep).
 */

import type { BrewStep, PreinfusionFill, PreinfusionGentleness } from "./types.js";

export interface PumpCurve {
  perBar: number;
  perMlS: number;
  offset: number;
}

export const DEFAULT_PUMP_CURVE: PumpCurve = { perBar: 3.26, perMlS: 9.5, offset: 9.4 };

/** Einstellungswert lesen; alles Unbrauchbare faellt auf die Standardkurve zurueck. */
export function parsePumpCurve(raw: string | null | undefined): PumpCurve {
  if (!raw) return DEFAULT_PUMP_CURVE;
  try {
    const c = JSON.parse(raw) as Partial<PumpCurve>;
    const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    if (ok(c.perBar) && ok(c.perMlS) && c.perMlS > 0 && ok(c.offset)) {
      return { perBar: c.perBar, perMlS: c.perMlS, offset: c.offset };
    }
  } catch {
    // fall through
  }
  return DEFAULT_PUMP_CURVE;
}

/** Pumpenleistung (%), die bei diesem Druck den gewuenschten Zulauf (ml/s) liefert. */
/** Ab diesem Druck foerdert die Pumpe weniger als die Gerade … */
export const HIGH_PRESSURE_FROM_BAR = 7;
/** … um so viel ml/s je bar darueber. */
export const HIGH_PRESSURE_LOSS_MLS = 0.1;

export function powerForInflow(curve: PumpCurve, pressureBar: number, inflowMlS: number): number {
  const loss = HIGH_PRESSURE_LOSS_MLS * Math.max(0, pressureBar - HIGH_PRESSURE_FROM_BAR);
  return curve.offset + curve.perBar * Math.max(0, pressureBar) + curve.perMlS * (inflowMlS + loss);
}

/** Fuellen: so schnell wie die bisherigen 45 % (bei 0 bar ≈ 3,7 ml/s). */
export const PREINFUSION_FILL_MLS = 3.5;
/** Ab diesem Gegendruck saettigt die Preinfusion sanfter — mit "none" nicht. */
export const PREINFUSION_SATURATE_FROM_BAR = 1;
export const PREINFUSION_SATURATE_MLS: Record<Exclude<PreinfusionGentleness, "none">, number> = {
  gentle: 1.5,
  normal: 2.0,
  brisk: 2.5,
};
/** Obergrenze der Pumpenleistung in der Preinfusion (Schutz, falls die Kennlinie daneben liegt). */
export const PREINFUSION_POWER_CAP = 60;
/** Schnell fuellen: volle Pumpe bis zum ersten Gegendruck — die Kennlinie gilt nur bis
 *  70 %, deshalb eine Leistung statt eines Zulaufs. Gemessen (#271–#273): ~5,6 ml/s bei
 *  0 bar; im Step-Down erster Tropfen 10,9 statt 16,6 s, kein Ueberschwingen (#280–#283). */
export const PREINFUSION_FAST_FILL_POWER = 100;
export const PREINFUSION_SOFT_START_MS = 3000;
/** Kaffee gilt als angekommen, wenn der Tassenfluss diesen Anteil des Startflusses erreicht. */
export const PREINFUSION_ARRIVAL_FRACTION = 0.9;

/** Pumpenleistung der Preinfusion in diesem Moment. */
export function preinfusionPower(
  curve: PumpCurve,
  gentleness: PreinfusionGentleness | undefined,
  pressureBar: number,
  inStageMs: number,
  softStartMs: number = PREINFUSION_SOFT_START_MS,
  fill: PreinfusionFill | undefined = undefined,
): number {
  const soak = gentleness === "none" ? null : PREINFUSION_SATURATE_MLS[gentleness ?? "normal"];
  const saturating = soak !== null && pressureBar >= PREINFUSION_SATURATE_FROM_BAR;
  const fast = !saturating && fill === "fast";
  const want = fast
    ? PREINFUSION_FAST_FILL_POWER
    : powerForInflow(curve, pressureBar, saturating ? soak : PREINFUSION_FILL_MLS);
  const cap = fast ? PREINFUSION_FAST_FILL_POWER : PREINFUSION_POWER_CAP;
  const softCap = softStartMs > 0 ? cap * Math.min(1, Math.max(0, inStageMs) / softStartMs) : cap;
  return Math.min(want, softCap);
}

/** Tassenfluss (g/s), ab dem der Kaffee als angekommen gilt — der Startfluss der
 *  naechsten Stufe, wenn sie eine Flussstufe ist; sonst kein solcher Ausstieg. */
export function preinfusionArrivalGs(next: BrewStep | undefined): number | null {
  return next?.kind === "flow" ? PREINFUSION_ARRIVAL_FRACTION * next.targetFlowGs : null;
}
