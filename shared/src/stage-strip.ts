/**
 * Stufenleiste der History-Detailansicht: welche Stufe wann lief und was sie
 * beendet hat.
 *
 *  - Flow-Bezuege: aus den echten Stufenwechseln des Treibers (shot_stage) und
 *    dem Profil-Schnappschuss des Bezugs (Namen, Rampen, Ausstiegswerte).
 *  - Skript-Bezuege: aus dem Skript selbst. Die Maschine arbeitet es nach der Uhr
 *    ab, Nominalzeit == echte Zeit — bis zum ersten unbestimmten Warten (Cmd 27
 *    „bis g“ / Cmd 26 „bis bar“ / Cmd 25 „bis °C“). Danach ist die Lage nur
 *    nominal (`uncertain`),
 *    genau wie bei der Soll-Kurve (script-overlay.ts).
 *
 * Reine Funktionen; die Anzeige formatiert Texte und Einheiten selbst.
 */

import type { BrewStep, ShotStage, StopMode } from "./types.js";
import { parseScript } from "./script-parser.js";
import { scriptToTimeline } from "./script-timeline.js";

/** Was eine Stufe tat. Leistung/Druck 0 = Pumpe aus (Pause/Bloom). */
export type StripWhat =
  | { kind: "flow"; value: number }
  | { kind: "pressure"; value: number }
  | { kind: "power"; value: number }
  | { kind: "preinfusion" };

/** Was eine Stufe beendet hat. `stop` = hier endete der ganze Bezug,
 *  `arrived` = der Kaffee kam in der Tasse an (Preinfusion). */
export type StripExit =
  | { kind: "seconds" | "weight" | "pressureAbove" | "pressureBelow" | "flowBelow" | "flowAbove"; value: number }
  | { kind: "arrived" }
  | { kind: "waitWeight" | "waitTemp" | "waitPressure"; value: number }
  | { kind: "stop"; mode: StopMode | null; weightG: number | null };

export interface StripSegment {
  startS: number;
  endS: number;
  what: StripWhat;
  /** Freitext-Name der Stufe aus dem Profil, sonst null. */
  name: string | null;
  /** Rampendauer in s (0 = sofort). */
  rampS: number;
  exit: StripExit | null;
  /** Skript nach einem unbestimmten Warten: Lage auf der Zeitachse nur nominal. */
  uncertain: boolean;
}

export interface StageStrip {
  segments: StripSegment[];
  /** Geplante Stufen, die nicht mehr drankamen — in Profil-/Skript-Reihenfolge. */
  notReached: StripWhat[];
}

/** Wie der Bezug endete: Stoppmodus + Zielgewicht, falls es ein Gewichtsstopp war. */
export interface StripStop {
  mode: StopMode | null;
  weightG: number | null;
}

const WAIT_EXIT = { weight: "waitWeight", temp: "waitTemp", pressure: "waitPressure" } as const;

const EXIT_KIND = {
  seconds: "seconds",
  weightG: "weight",
  pressureBar: "pressureAbove",
  pressureBelowBar: "pressureBelow",
  flowGs: "flowBelow",
  flowAboveGs: "flowAbove",
} as const;

function whatOfStep(step: BrewStep): StripWhat {
  switch (step.kind) {
    case "flow": return { kind: "flow", value: step.targetFlowGs };
    case "pressure": return { kind: "pressure", value: step.targetPressureBar };
    case "power": return { kind: "power", value: step.power };
    case "preinfusion": return { kind: "preinfusion" };
  }
}

function whatOfStage(st: ShotStage, step: BrewStep | undefined): StripWhat {
  // Die Preinfusion steht in shot_stage als Leistungsstufe (die Spalte kennt nur
  // flow/pressure/power) — was sie war, sagt der Profil-Schnappschuss.
  if (step?.kind === "preinfusion") return { kind: "preinfusion" };
  const recorded =
    st.stepKind === "flow" ? st.targetFlowGs
      : st.stepKind === "pressure" ? st.targetPressureBar
        : st.targetPower;
  if (recorded !== null) return { kind: st.stepKind, value: recorded };
  return step ? whatOfStep(step) : { kind: st.stepKind, value: 0 };
}

/**
 * Flow-Bezug. `brewEndS` = Ende des Brühens (erster Nachlauf-Messpunkt), nicht
 * das Ende der Aufzeichnung — die laeuft beim Nachlauf noch bis zu 15 s weiter.
 */
export function flowStageStrip(
  stages: ShotStage[],
  steps: BrewStep[],
  brewEndS: number,
  stop: StripStop,
): StageStrip | null {
  if (stages.length === 0) return null;
  const segments = stages.map((st, i): StripSegment => {
    const step = steps[st.stageIndex];
    // Stufe 0 beginnt vor dem ersten Messpunkt (der Treiber laeuft der
    // Brueh-Meldung der Maschine voraus) — an die Achse klemmen.
    const startS = Math.max(0, st.enteredMs / 1000);
    const nextS = i + 1 < stages.length ? stages[i + 1].enteredMs / 1000 : brewEndS;
    let exit: StripExit | null = null;
    if (i === stages.length - 1) {
      exit = { kind: "stop", mode: stop.mode, weightG: stop.weightG };
    } else if (st.exitReason === "arrived") {
      exit = { kind: "arrived" };
    } else if (st.exitReason !== null) {
      const v = step?.exit[st.exitReason];
      if (v !== undefined) exit = { kind: EXIT_KIND[st.exitReason], value: v };
    }
    return {
      startS,
      endS: Math.max(startS, nextS),
      what: whatOfStage(st, step),
      name: step?.name?.trim() || null,
      rampS: (step?.rampMs ?? 0) / 1000,
      exit,
      uncertain: false,
    };
  });
  const lastIndex = stages[stages.length - 1].stageIndex;
  return { segments, notReached: steps.slice(lastIndex + 1).map(whatOfStep) };
}

/** Skript-Bezug — siehe Kopfkommentar zur zeitlichen Zuordnung. */
export function scriptStageStrip(
  content: string,
  brewEndS: number,
  stop: StripStop,
): StageStrip | null {
  const tl = scriptToTimeline(parseScript(content));
  // Ein sofort ueberschriebener Befehl (kein Warten danach) lief nie wirklich.
  const phases = tl.phases.filter((p) => !p.noWait);
  if (phases.length === 0) return null;
  const firstWaitMs = tl.waits.length > 0 ? Math.min(...tl.waits.map((w) => w.tStart)) : null;
  const segments: StripSegment[] = [];
  const notReached: StripWhat[] = [];
  for (const p of phases) {
    const what: StripWhat = { kind: p.mode, value: p.rawTarget };
    const startS = p.tStart / 1000;
    if (startS >= brewEndS) {
      notReached.push(what);
      continue;
    }
    const endS = p.tEnd / 1000;
    const wait = tl.waits.find((w) => w.tStart >= p.tStart && w.tStart < p.tEnd);
    const exit: StripExit =
      endS >= brewEndS ? { kind: "stop", mode: stop.mode, weightG: stop.weightG }
        : wait ? { kind: WAIT_EXIT[wait.kind], value: wait.value }
          : { kind: "seconds", value: (p.tEnd - p.tStart) / 1000 };
    segments.push({
      startS,
      endS: Math.min(endS, brewEndS),
      what,
      name: null,
      rampS: Math.min(p.rampDurMs, p.tEnd - p.tStart) / 1000,
      exit,
      uncertain: firstWaitMs !== null && p.tStart > firstWaitMs,
    });
  }
  return { segments, notReached };
}

/**
 * Ende der Preinfusion eines Flow-Bezugs = Ende der ersten Stufe, wenn sie eine
 * Leistungs- oder Druckstufe ist. Ein Bloom danach zaehlt nicht mit (Filter:
 * 21 s statt 141 s), er steht als eigene Stufe in der Leiste. Startet das Profil
 * direkt mit Fluss, gibt es keine Preinfusions-Stufe → null (die Anzeige nimmt
 * dann den Messwert).
 */
export function flowPreinfusionEndS(stages: ShotStage[]): number | null {
  if (stages.length < 2 || stages[0].stepKind === "flow") return null;
  return Math.max(0, stages[1].enteredMs / 1000);
}

/** Ab diesem Gewicht gilt etwas als in der Tasse angekommen. */
export const FIRST_DROP_G = 0.3;

/**
 * Erster Tropfen: erstes Gewicht ≥ FIRST_DROP_G, das auch im naechsten Messpunkt
 * noch steht — ein einzelner Ausreisser der Waage zaehlt nicht.
 */
export function firstDropS(samples: { t: number; weight: number | null }[]): number | null {
  for (let i = 0; i + 1 < samples.length; i++) {
    const a = samples[i].weight, b = samples[i + 1].weight;
    if (a !== null && b !== null && a >= FIRST_DROP_G && b >= FIRST_DROP_G) return samples[i].t;
  }
  return null;
}
