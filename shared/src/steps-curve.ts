/**
 * App-Stufen als Kurve — in derselben Form wie ein Skript (ScriptTimeline),
 * damit der vereinte Editor beide gleich zeichnet und an beiden gleich ziehen
 * laesst (Schnitt 2d).
 *
 * Zeitachse nominal, wie die Soll-Kurve sie schon immer schaetzt (buildPhases):
 * ein Zeit-Ausstieg ist die Dauer; ein Druck- oder Fluss-Ausstieg feuert meist
 * frueher, also hoechstens 10 s; ein Gewicht in einer Flussphase wird aus dem
 * Zielfluss geschaetzt; die letzte Phase endet am Yield. Wo das Ende vom Puck
 * abhaengt, liegt wie bei „Warten bis …“ im Skript ein Band ueber der Phase.
 *
 * Rampen beginnen beim letzten Sollwert derselben Art (FlowHoldDriver:
 * stageRampFrom), die erste Flussphase nach Leistung/Preinfusion am Ist-Fluss —
 * den kennt der Entwurf nicht, deshalb nur angedeutet und nie ab Null.
 */

import type { BrewStep } from "./types.js";
import type { ScriptPhase, ScriptTimeline, WaitSegment } from "./script-timeline.js";
import { powerToBar } from "./script-timeline.js";
import { barToPower, MAX_PRESSURE_BAR } from "./script-edit.js";
import { preinfusionArrivalGs } from "./pump-curve.js";
import { L } from "./shared-lang.js";

/** Sekunden fuer eine Phase, deren Ende rein zustandsabhaengig ist. */
export const FALLBACK_DURATION_S = 10;
/** Einstiegshoehe der angedeuteten Flussrampe, als Anteil des Ziels — rein optisch. */
export const RAMP_HINT_FRAC = 0.55;

export interface NominalPhase {
  step: BrewStep;
  tStart: number;
  tEnd: number;
  rampS: number;
}

/** Ein Druck-/Flow-Exit feuert normalerweise lange vor dem Sekunden-Exit — der ist dann nur Sicherheitsgrenze. */
const endsByState = (step: BrewStep) => step.exit.pressureBar != null || step.exit.flowGs != null;

function nominalDuration(step: BrewStep, cumG: number, yieldTargetG: number | null): number {
  const e = step.exit;
  // Sonst wuerde die Sicherheitsgrenze die Phase kuenstlich strecken.
  if (endsByState(step)) {
    return Math.min(e.seconds ?? FALLBACK_DURATION_S, FALLBACK_DURATION_S);
  }
  if (e.seconds != null) return e.seconds;
  const targetW = e.weightG ?? yieldTargetG;
  if (targetW != null && step.kind === "flow" && step.targetFlowGs > 0) {
    return Math.min(90, Math.max(4, (targetW - cumG) / step.targetFlowGs));
  }
  return FALLBACK_DURATION_S;
}

/** Nominale Phasen der Soll-Kurve — auch die Kurvenvorschau der Profilliste nutzt sie. */
export function buildPhases(steps: BrewStep[], yieldTargetG: number | null): NominalPhase[] {
  const phases: NominalPhase[] = [];
  let t = 0;
  let cumG = 0;
  steps.forEach((step, i) => {
    const isLast = i === steps.length - 1;
    const dur = nominalDuration(step, cumG, isLast ? yieldTargetG : null);
    phases.push({ step, tStart: t, tEnd: t + dur, rampS: Math.min(dur, (step.rampMs ?? 0) / 1000) });
    // Präinfusion (Power) liefert annahmegemäß nichts — reicht für die Schätzung.
    if (step.kind === "flow") cumG += step.targetFlowGs * dur;
    t += dur;
  });
  return phases;
}

const num = (v: number) => String(Math.round(v * 100) / 100).replace(".", L(",", "."));

/** Wodurch die Phase endet, wenn nicht nach Uhr — Beschriftung des Bands; null = nach Uhr. */
function openEnd(steps: BrewStep[], i: number, yieldG: number | null): string | null {
  const s = steps[i]!;
  const until = L("bis", "until");
  if (i === steps.length - 1) return yieldG !== null ? `${until} ${num(yieldG)} g` : null;
  const arrival = s.kind === "preinfusion" ? preinfusionArrivalGs(steps[i + 1]) : null;
  if (arrival !== null) return `${until} F ≥ ${num(arrival)} g/s`;
  const e = s.exit;
  if (e.weightG != null) return `${until} ${num(e.weightG)} g`;
  if (e.pressureBar != null) return `${until} ${num(e.pressureBar)} bar`;
  if (e.pressureBelowBar != null) return `${until} P ≤ ${num(e.pressureBelowBar)} bar`;
  if (e.flowGs != null) return `${until} F ≤ ${num(e.flowGs)} g/s`;
  if (e.flowAboveGs != null) return `${until} F ≥ ${num(e.flowAboveGs)} g/s`;
  return null;
}

/**
 * Die Stufen als Timeline wie aus scriptToTimeline. `cmdIndex` ist hier der
 * Index der Stufe — der Editor waehlt und zieht ueber ihn.
 */
export function stepsToTimeline(steps: BrewStep[], yieldG: number | null): ScriptTimeline {
  const nominal = buildPhases(steps, yieldG);
  const phases: ScriptPhase[] = [];
  const waits: WaitSegment[] = [];
  const last = { pressure: 0, power: 0, flow: null as number | null };
  nominal.forEach((n, i) => {
    const s = n.step;
    const tStart = Math.round(n.tStart * 1000);
    const tEnd = Math.round(n.tEnd * 1000);
    const rampDurMs = Math.round(n.rampS * 1000);
    const base = { cmdIndex: i, tStart, tEnd, rampEndT: tStart + rampDurMs, rampDurMs, truncated: false, noWait: false };
    if (s.kind === "flow") {
      const entry = last.flow === null;
      const from = rampDurMs > 0 ? (entry ? RAMP_HINT_FRAC * s.targetFlowGs : last.flow!) : s.targetFlowGs;
      phases.push({
        ...base, mode: "flow", unit: "ml/s", axis: "flow", startValue: from, targetValue: s.targetFlowGs, endValue: s.targetFlowGs,
        rawTarget: s.targetFlowGs,
        // Uebernommen: das Ziel steht erst beim Eintritt fest, die Kurve zeigt den erwarteten Wert.
        label: s.adoptFlow
          ? L(`Fluss halten ≈ ${num(s.targetFlowGs)} g/s`, `Hold flow ≈ ${num(s.targetFlowGs)} g/s`)
          : L(`Fluss ${num(s.targetFlowGs)} g/s`, `Flow ${num(s.targetFlowGs)} g/s`),
        startEstimated: entry && rampDurMs > 0,
      });
      last.flow = s.targetFlowGs;
    } else if (s.kind === "pressure") {
      const from = rampDurMs > 0 ? last.pressure : s.targetPressureBar;
      phases.push({
        ...base, mode: "pressure", unit: "bar", axis: "bar", startValue: from, targetValue: s.targetPressureBar, endValue: s.targetPressureBar,
        rawTarget: s.targetPressureBar,
        label: s.adoptPressure
          ? L(`Druck halten ≈ ${num(s.targetPressureBar)} bar`, `Hold pressure ≈ ${num(s.targetPressureBar)} bar`)
          : L(`Druck ${num(s.targetPressureBar)} bar`, `Pressure ${num(s.targetPressureBar)} bar`),
      });
      last.pressure = s.targetPressureBar;
      last.flow = null;
    } else if (s.kind === "power") {
      const target = powerToBar(s.power);
      const from = rampDurMs > 0 ? powerToBar(last.power) : target;
      phases.push({
        ...base, mode: "power", unit: "%", axis: "bar", startValue: from, targetValue: target, endValue: target,
        rawTarget: s.power, label: L(`Leistung ${num(s.power)} %`, `Power ${num(s.power)} %`),
      });
      last.power = s.power;
      last.flow = null;
    } else {
      // Preinfusion: kein fester Sollwert — sie folgt dem Gegendruck. Nur die Flaeche.
      phases.push({
        ...base, rampEndT: tStart, rampDurMs: 0, mode: "power", unit: "%", axis: "bar", startValue: 0, targetValue: 0, endValue: 0,
        rawTarget: 0, label: "Preinfusion", noTarget: true,
      });
      last.flow = null;
    }
    // Endet die Stufe beim Erreichen eines Drucks, steht er danach an — eine folgende
    // Druckrampe beginnt dort (der Treiber startet sie beim gemessenen Druck), nicht bei 0.
    if (s.exit.pressureBar != null) last.pressure = s.exit.pressureBar;
    const open = openEnd(steps, i, yieldG);
    if (open !== null) {
      const kind = s.exit.weightG != null || i === steps.length - 1 ? "weight" : "pressure";
      waits.push({ kind, value: 0, label: open, tStart, tEnd });
    }
  });
  const totalMs = phases.length ? phases[phases.length - 1]!.tEnd : 0;
  return { phases, waits, tempSetpoints: [], pressureLimitBar: null, flowLimitMlS: null, markers: [], totalMs };
}

// ---------------------------------------------------------------------------
// Ziehen an App-Stufen — nur die eine Stufe aendert sich
// ---------------------------------------------------------------------------

const ROUND = (v: number, step: number) => Math.round(v / step) * step;
const clean = (v: number) => Math.round(v * 1000) / 1000;

/** Hat die Stufe einen Ziel-Griff (●)? Pause und Preinfusion nicht. */
export function stepHasPoint(s: BrewStep): boolean {
  if (s.kind === "flow" || s.kind === "pressure") return true;
  return s.kind === "power" && !(s.power === 0 && s.maxPressureBar == null && s.maxFlowGs == null);
}

/**
 * Hat die Stufe einen Dauer-Griff (▮)? Nur wenn ihre Zeit das Ende bestimmt:
 * mit Zeit-Ausstieg, ohne Druck-/Fluss-Ausstieg (dann ist die Zeit nur
 * Sicherheitsgrenze und die Kurve zeigt sie nicht) und nicht als letzte — die
 * endet am Yield, ihre Ausstiege wertet der Antrieb nicht aus.
 */
export function stepHasEnd(steps: BrewStep[], i: number): boolean {
  const s = steps[i];
  return !!s && i < steps.length - 1 && s.exit.seconds != null && !endsByState(s);
}

/** Ziel (in der Achseneinheit: bar bzw. bar-Aequivalent, g/s) und Rampe einer Stufe setzen. */
export function setStepPoint(steps: BrewStep[], i: number, axisValue: number, rampMs: number, rampStepMs = 500): BrewStep[] {
  const s = steps[i];
  if (!s || !stepHasPoint(s)) return steps;
  const ramp = Math.max(0, ROUND(rampMs, rampStepMs));
  let next: BrewStep;
  if (s.kind === "pressure") next = { ...s, targetPressureBar: clean(Math.max(0.1, Math.min(MAX_PRESSURE_BAR, ROUND(axisValue, 0.1)))) };
  else if (s.kind === "flow") next = { ...s, targetFlowGs: clean(Math.max(0.1, Math.min(8, ROUND(axisValue, 0.1)))) };
  else if (s.kind === "power") next = { ...s, power: barToPower(axisValue) };
  else return steps;
  next = ramp > 0 ? { ...next, rampMs: ramp } : withoutRamp(next);
  return steps.map((x, k) => (k === i ? next : x));
}

function withoutRamp(s: BrewStep): BrewStep {
  const { rampMs: _drop, ...rest } = s as BrewStep & { rampMs?: number };
  void _drop;
  return rest as BrewStep;
}

/** Dauer einer Stufe (Zeit-Ausstieg) um `deltaMs` verschieben, gerastert, mindestens 0,5 s. */
export function shiftStepEnd(steps: BrewStep[], i: number, deltaMs: number, stepMs = 500): BrewStep[] {
  const s = steps[i];
  if (!s || !stepHasEnd(steps, i)) return steps;
  const cur = s.exit.seconds!;
  const next = Math.max(0.5, ROUND(cur * 1000 + deltaMs, stepMs) / 1000);
  if (next === cur) return steps;
  return steps.map((x, k) => (k === i ? { ...x, exit: { ...x.exit, seconds: clean(next) } } as BrewStep : x));
}
