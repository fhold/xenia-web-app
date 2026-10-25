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

/** Darunter wuerde Q/(2p) in der Rampen-Vorsteuerung explodieren. */
const RAMP_FF_MIN_BAR = 2;
/** Obergrenze der Steigung (%/bar) — Schutz gegen einen ausreissenden Fluss-Messwert. */
const RAMP_FF_MAX_SLOPE = 10;

/**
 * Vorsteuerung einer Druckrampe: um wie viel % sich die Pumpenleistung aendert, wenn
 * der Solldruck um `deltaBar` wandert — die Steigung der Kennlinie entlang der
 * Puck-Kennlinie Q = k·√p: dP/dp = perBar + perMlS · Q/(2p), Q = aktueller Tassenfluss.
 * So macht es die Firmware im Skript (#250, #264). Gegenprobe #285: bei 7 bar und
 * 1,5 g/s 4,3 %/bar, Rampe −0,32 bar/s → −1,4 %/s; der PI allein brauchte dafuer
 * dauerhaft ~0,8 bar Abweichung (1,6 %/s / ki 2).
 */
export function pressureRampFeedForward(curve: PumpCurve, deltaBar: number, pressureBar: number, flowGs: number): number {
  const p = Math.max(RAMP_FF_MIN_BAR, pressureBar);
  const slope = Math.min(RAMP_FF_MAX_SLOPE, curve.perBar + (curve.perMlS * Math.max(0, flowGs)) / (2 * p));
  return slope * deltaBar;
}

/** Pumpenleistung (%), die bei diesem Druck den gewuenschten Zulauf (ml/s) liefert. */
export function powerForInflow(curve: PumpCurve, pressureBar: number, inflowMlS: number): number {
  return curve.offset + curve.perBar * Math.max(0, pressureBar) + curve.perMlS * inflowMlS;
}

/** Fuellen: so schnell wie die bisherigen 45 % (bei 0 bar ≈ 3,7 ml/s). */
export const PREINFUSION_FILL_MLS = 3.5;
/** Ab diesem Gegendruck saettigt die Preinfusion sanfter. */
export const PREINFUSION_SATURATE_FROM_BAR = 1;
export const PREINFUSION_SATURATE_MLS: Record<PreinfusionGentleness, number> = {
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
  const saturating = pressureBar >= PREINFUSION_SATURATE_FROM_BAR;
  const fast = !saturating && fill === "fast";
  const want = fast
    ? PREINFUSION_FAST_FILL_POWER
    : powerForInflow(curve, pressureBar, saturating ? PREINFUSION_SATURATE_MLS[gentleness ?? "normal"] : PREINFUSION_FILL_MLS);
  const cap = fast ? PREINFUSION_FAST_FILL_POWER : PREINFUSION_POWER_CAP;
  const softCap = softStartMs > 0 ? cap * Math.min(1, Math.max(0, inStageMs) / softStartMs) : cap;
  return Math.min(want, softCap);
}

/** Tassenfluss (g/s), ab dem der Kaffee als angekommen gilt — der Startfluss der
 *  naechsten Stufe, wenn sie eine Flussstufe ist; sonst kein solcher Ausstieg. */
export function preinfusionArrivalGs(next: BrewStep | undefined): number | null {
  return next?.kind === "flow" ? PREINFUSION_ARRIVAL_FRACTION * next.targetFlowGs : null;
}
