/**
 * ProfileSparkline — die Soll-Kurve eines Profils als kleine Vorschau in der
 * Profilliste.
 *
 * Keine eigene Kurvenlogik: Skript-Profile zeichnen die Phasen aus
 * scriptToTimeline (wie Skript-Ansicht und Skript-Editor), App-Profile die
 * nominalen Phasen der Soll-Kurve im Profil-Editor (buildPhases). Jede Art
 * (Druck, Fluss, Leistung) ist auf ihre eigene Skala normiert — die Vorschau
 * zeigt die Form, keine Werte.
 */

import type { Profile, XeniaScript } from "@shared/types.js";
import { scriptToTimeline } from "@shared/script-timeline.js";
import type { PumpMode } from "@shared/script-timeline.js";
import { buildPhases } from "@shared/steps-curve.js";
import theme from "../theme.js";

const C = theme;
const MODE_COLOR: Record<PumpMode, string> = { pressure: C.seriesPressure, flow: C.seriesFlow, power: C.seriesPower };

/** Ein Abschnitt: von `from` zur Zeit t0 auf `to` bei tr, dann gehalten bis t1 (Werte 0..1). */
interface Run { t0: number; tr: number; t1: number; from: number; to: number; color: string }

function stepRuns(p: Profile): { runs: Run[]; total: number } | null {
  const steps = p.brewSteps?.steps ?? [];
  if (steps.length === 0) return null;
  const phases = buildPhases(steps, p.yieldTargetSingleG);
  let maxFlow = 0;
  for (const s of steps) if (s.kind === "flow") maxFlow = Math.max(maxFlow, s.targetFlowGs);
  const norm = (s: (typeof steps)[number]): number => {
    if (s.kind === "flow") return maxFlow > 0 ? s.targetFlowGs / maxFlow : 0;
    if (s.kind === "pressure") return s.targetPressureBar / 12;
    if (s.kind === "power") return s.power / 100;
    return 0.25; // Preinfusion: fuellt mit wenig Leistung, hat keinen Zielwert
  };
  const runs: Run[] = [];
  let prev: { kind: string; v: number } | null = null;
  for (const ph of phases) {
    const v = norm(ph.step);
    // Gleiche Art: Rampe vom vorigen Wert; neue Art: direkt auf dem Ziel, nie ab Null.
    const from = prev && prev.kind === ph.step.kind ? prev.v : v;
    const color = ph.step.kind === "flow" ? C.seriesFlow : ph.step.kind === "pressure" ? C.seriesPressure : C.seriesPower;
    runs.push({ t0: ph.tStart, tr: ph.tStart + ph.rampS, t1: ph.tEnd, from, to: v, color });
    prev = { kind: ph.step.kind, v };
  }
  return { runs, total: phases[phases.length - 1]!.tEnd };
}

function scriptRuns(script: XeniaScript | undefined): { runs: Run[]; total: number } | null {
  if (!script?.parsedCmds) return null;
  const tl = scriptToTimeline(script.parsedCmds);
  const live = tl.phases.filter((ph) => !ph.noWait);
  if (live.length === 0 || tl.totalMs <= 0) return null;
  const runs = live.map((ph): Run => {
    const scale = ph.axis === "flow" ? 8 : 12;
    const reached = !ph.truncated && ph.rampDurMs > 0 && ph.rampEndT > ph.tStart;
    return {
      t0: ph.tStart,
      tr: reached ? ph.rampEndT : ph.tEnd,
      t1: ph.tEnd,
      from: ph.startValue / scale,
      to: (reached ? ph.targetValue : ph.endValue) / scale,
      color: MODE_COLOR[ph.mode],
    };
  });
  return { runs, total: tl.totalMs };
}

export function ProfileSparkline({ profile, script, width = 120, height = 30 }: {
  profile: Profile;
  /** Das Single-Skript eines Skript-Profils; fehlt es (noch nicht geladen), keine Vorschau. */
  script?: XeniaScript;
  width?: number;
  height?: number;
}) {
  const curve = profile.brewSteps ? stepRuns(profile) : scriptRuns(script);
  if (!curve) return null;
  const P = 3;
  const x = (t: number) => (P + (t / curve.total) * (width - 2 * P)).toFixed(1);
  const y = (v: number) => (height - P - Math.max(0, Math.min(1, v)) * (height - 2 * P)).toFixed(1);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={{ flexShrink: 0 }}>
      {curve.runs.map((r, i) => (
        <path
          key={i}
          d={`M${x(r.t0)} ${y(r.from)} L${x(r.tr)} ${y(r.to)} L${x(r.t1)} ${y(r.to)}`}
          fill="none"
          stroke={r.color}
          strokeWidth={1.8}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
