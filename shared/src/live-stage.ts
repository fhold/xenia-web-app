/**
 * App-Bezug: Sollkurve der gelaufenen Stufen und der Sollwert einer Stufe zu
 * einem Zeitpunkt — eine Rechnung für das Dashboard und die Historie.
 *
 * Läuft der Bezug, ist die Quelle allein der Treiber: jede WS-Nachricht
 * `driveStage` trägt Eintritt und Sollwert (Rampenstart beim gemessenen Wert,
 * übernommenes Ziel), der Server spielt die Stufen eines laufenden Bezugs neu
 * verbundenen Geräten vor. Ist er beendet, kommen dieselben Einträge aus den
 * gespeicherten Stufen (`recordedStageEntries`). Künftige Stufen zeichnet die
 * Kurve nicht — ihr Beginn hängt am Ausstieg.
 */

import type { BrewStep, DriveStage, ShotStage } from "./types.js";

export interface LiveStageEntry {
  kind: DriveStage["kind"];
  /** Sekunden seit Bezugsbeginn (Stufe 0 liegt davor → 0). */
  t: number;
  setpoint: DriveStage["setpoint"];
}

export interface LiveSoll {
  bar: { t: number; v: number }[];
  flow: { t: number; v: number }[];
}

/** Stufen des Treibers auf die Zeitachse des Bezugs (Sekunden ab `startedAt`). */
export function liveStageEntries(stages: DriveStage[], startedAt: number): LiveStageEntry[] {
  return stages.map((s) => ({ kind: s.kind, t: Math.max(0, (s.enteredAt - startedAt) / 1000), setpoint: s.setpoint }));
}

/** Messpunkt eines beendeten Bezugs (Sekunden ab Bezugsbeginn). */
export interface SollSample {
  t: number;
  pressure: number | null;
  flow: number | null;
}

/**
 * Gespeicherte Stufen (shot_stage + Profil-Schnappschuss des Bezugs) als Einträge
 * wie live. Das Ziel steht in der Stufe (bei „übernehmen“ der übernommene Wert);
 * die Rampe startet wie im Treiber beim letzten Messwert bis zum Eintritt. Die
 * Preinfusion ist als Leistungsstufe gespeichert — wie Leistungsstufen ohne Sollwert.
 */
export function recordedStageEntries(stages: ShotStage[], steps: BrewStep[], samples: SollSample[]): LiveStageEntry[] {
  return stages.map((st) => {
    const step = steps[st.stageIndex];
    const t = Math.max(0, st.enteredMs / 1000);
    if (st.stepKind === "power") return { kind: step?.kind === "preinfusion" ? "preinfusion" : "power", t, setpoint: null };
    const to = st.stepKind === "flow" ? st.targetFlowGs : st.targetPressureBar;
    if (to === null) return { kind: st.stepKind, t, setpoint: null };
    const snap = (step?.kind === "flow" || step?.kind === "pressure") && step.kind === st.stepKind ? step : undefined;
    const rampMs = snap?.rampMs !== undefined && snap.rampMs > 0 ? snap.rampMs : 0;
    const planned = snap?.kind === "flow" ? snap.targetFlowGs : snap?.kind === "pressure" ? snap.targetPressureBar : to;
    const from = rampMs > 0 ? (measuredAt(samples, st.enteredMs / 1000, st.stepKind) ?? to) : to;
    return { kind: st.stepKind, t, setpoint: { from, to, rampMs, adopted: to !== planned } };
  });
}

/** Letzter Messwert bis `t`; vor dem ersten Messpunkt (Stufe 0 beginnt vor dem Bezug) der erste. */
function measuredAt(samples: SollSample[], t: number, kind: "flow" | "pressure"): number | null {
  let v: number | null = null;
  for (const s of samples) {
    const x = kind === "flow" ? s.flow : s.pressure;
    if (x === null) continue;
    if (s.t > t) return v ?? x;
    v = x;
  }
  return v;
}

/** Ende des Brühens in Sekunden: der erste Nachlauf-Messpunkt (danach tropft es nur
 *  noch nach), ohne Nachlauf der letzte Messpunkt. Dort endet die letzte Stufe. */
export function brewEndSeconds(samples: { elapsedMs: number; phase: string }[]): number {
  const end = samples.find((s) => s.phase === "post_brew") ?? samples[samples.length - 1];
  return end ? end.elapsedMs / 1000 : 0;
}

/** Sollwert `t` Sekunden nach Bezugsbeginn in einer Stufe, die bei `start` begann. */
export function setpointAt(sp: NonNullable<DriveStage["setpoint"]>, start: number, t: number): number {
  if (sp.rampMs <= 0) return sp.to;
  return sp.from + (sp.to - sp.from) * Math.min(1, Math.max(0, (t - start) / (sp.rampMs / 1000)));
}

/** Sollkurve der gelaufenen Druck- und Flussstufen bis `nowT`. */
export function liveSollCurve(entries: LiveStageEntry[], nowT: number): LiveSoll {
  const out: LiveSoll = { bar: [], flow: [] };
  entries.forEach((e, i) => {
    const sp = e.setpoint;
    if (!sp || (e.kind !== "pressure" && e.kind !== "flow")) return;
    const start = e.t;
    const end = Math.max(start, i + 1 < entries.length ? entries[i + 1]!.t : nowT);
    const line = e.kind === "pressure" ? out.bar : out.flow;
    const rampEnd = start + sp.rampMs / 1000;
    line.push({ t: start, v: setpointAt(sp, start, start) });
    if (sp.rampMs > 0 && rampEnd < end) line.push({ t: rampEnd, v: sp.to });
    line.push({ t: end, v: setpointAt(sp, start, end) });
  });
  return out;
}
