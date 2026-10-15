/**
 * ProfileSollChart — Soll-Kurve des Flow-Profils (Design-Vorlage "FlowProfil").
 *
 * Handgezeichnetes SVG statt Recharts: die Vorlage lebt von Beschriftungen, die
 * Recharts so nicht platziert (Ziel-Werte über den Plateaus, Exit-Bedingungen
 * zweizeilig unter der Achse, Master-Stop rechts).
 *
 * Kurvenlogik (muss dem FlowHoldDriver entsprechen):
 *  - Power-Phase: eigene gestrichelte Amber-Kurve auf indikativer 0–100-%-Skala.
 *    KEINE Flow-Soll-Linie.
 *  - Die Flow-Soll beginnt bei der ersten Flow-Phase direkt AUF ihrem Ziel
 *    (Einstiegspunkt = gemessener Ist-Flow, hier nicht darstellbar → Punkt-
 *    Marker) — nie ein Anstieg ab Null.
 *  - Folgephasen: rampMs 0 = harter Sprung, rampMs > 0 = Schräge auf das Ziel.
 *  - Druck-/Power-Schrägen beginnen beim letzten Sollwert DERSELBEN Art, nicht
 *    auf der Grundlinie — sonst zeigt eine fallende Rampe nach oben.
 *
 * Die Zeitachse ist nominal: nur `seconds` ist eine echte Dauer, Gewichts-Exits
 * werden aus dem Ziel-Flow geschätzt, Druck-/Flow-Exits sind zustandsabhängig.
 */

import type { BrewStep, PreinfusionGentleness, StepExit } from "@shared/types.js";
import theme, { alpha } from "../theme.js";

const C = theme;
const SOLL = C.seriesTarget;

const KIND_COLOR: Record<BrewStep["kind"], string> = {
  flow: C.seriesFlow,
  pressure: C.seriesPressure,
  power: C.seriesPower,
  preinfusion: C.seriesPower,
};

const BAND_FILL: Record<BrewStep["kind"], string> = {
  flow: alpha(C.seriesFlow, 0.038),
  pressure: alpha(C.seriesPressure, 0.05),
  power: alpha(C.seriesPower, 0.05),
  preinfusion: alpha(C.seriesPower, 0.05),
};

/** Sekunden für eine Phase, deren Exit rein zustandsabhängig ist. */
const FALLBACK_DURATION_S = 10;
/** Indikative Skala der Druck-Kurve (die Achse gehört dem Flow). */
const BAR_SCALE_MAX = 12;
/** Einstiegshöhe der angedeuteten Rampe, als Anteil des Ziels. Rein optisch —
 *  der echte Startwert ist der gemessene Ist-Flow. Bewusst deutlich über 0. */
const RAMP_HINT_FRAC = 0.55;

function de(n: number): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: 2 });
}
function fmt1(n: number): string {
  return n.toFixed(1).replace(".", ",");
}

export const GENTLENESS_LABEL: Record<PreinfusionGentleness, string> = {
  gentle: "sanft",
  normal: "normal",
  brisk: "zügig",
};

export function autoStepLabel(step: BrewStep): string {
  if (step.kind === "flow") return `Flow ${fmt1(step.targetFlowGs)} g/s`;
  if (step.kind === "pressure") return `Druck ${de(step.targetPressureBar)} bar`;
  if (step.kind === "preinfusion") return `Preinfusion ${GENTLENESS_LABEL[step.gentleness ?? "normal"]}`;
  return `Power ${de(step.power)} %`;
}

export function stepLabel(step: BrewStep): string {
  return step.name?.trim() ? step.name.trim() : autoStepLabel(step);
}

/** Exit-Bedingungen einer Phase in Anzeigereihenfolge. Auch ein Gewichts-Exit
 *  ist hier nur eine Phasengrenze — der Ziel-Stopp der letzten Phase wird
 *  separat rechts gezeichnet. */
export function exitConditions(exit: StepExit): string[] {
  const out: string[] = [];
  if (exit.weightG != null) out.push(`${de(exit.weightG)} g`);
  if (exit.pressureBar != null) out.push(`P ≥ ${de(exit.pressureBar)} bar`);
  if (exit.flowGs != null) out.push(`F ≤ ${de(exit.flowGs)}`);
  if (exit.seconds != null) out.push(`${de(exit.seconds)} s`);
  return out;
}

interface Phase {
  step: BrewStep;
  tStart: number;
  tEnd: number;
  rampS: number;
}

function nominalDuration(step: BrewStep, cumG: number, yieldTargetG: number | null): number {
  const e = step.exit;
  // Ein Druck-/Flow-Exit feuert normalerweise lange vor dem Sekunden-Exit —
  // der ist eine Sicherheitsgrenze und würde die Phase künstlich strecken.
  if (e.pressureBar != null || e.flowGs != null) {
    return Math.min(e.seconds ?? FALLBACK_DURATION_S, FALLBACK_DURATION_S);
  }
  if (e.seconds != null) return e.seconds;
  const targetW = e.weightG ?? yieldTargetG;
  if (targetW != null && step.kind === "flow" && step.targetFlowGs > 0) {
    return Math.min(90, Math.max(4, (targetW - cumG) / step.targetFlowGs));
  }
  return FALLBACK_DURATION_S;
}

function buildPhases(steps: BrewStep[], yieldTargetG: number | null): Phase[] {
  const phases: Phase[] = [];
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

// SVG-Geometrie der Vorlage.
const W = 920;
const H = 300;
const L = 48;
const R = 896;
const T = 30;
const B = 246;

export function ProfileSollChart({
  steps,
  yieldTargetG = null,
}: {
  steps: BrewStep[];
  yieldTargetG?: number | null;
}) {
  if (steps.length === 0) return null;

  const phases = buildPhases(steps, yieldTargetG);
  const totalT = phases[phases.length - 1].tEnd;

  let maxFlow = 0;
  for (const s of steps) if (s.kind === "flow") maxFlow = Math.max(maxFlow, s.targetFlowGs);
  const fmax = maxFlow > 0 ? Math.ceil(maxFlow * 12.7) / 10 : 1;

  const x = (t: number) => L + (t / totalT) * (R - L);
  const yF = (f: number) => B - (f / fmax) * (B - T);

  const gridStep = fmax > 3 ? 1 : 0.5;
  const ticks: number[] = [];
  for (let v = gridStep; v < fmax - 0.05; v += gridStep) ticks.push(parseFloat(v.toFixed(2)));

  // Flow-Treppe: je zusammenhängendem Lauf von Flow-Phasen ein Pfad.
  const flowPaths: string[] = [];
  const entryDots: { cx: number; cy: number }[] = [];
  // Rampe der ERSTEN Flow-Phase eines Laufs: der Eintrittswert ist der gemessene
  // Ist-Flow, zur Entwurfszeit unbekannt. Die Schräge wird deshalb nur ANGEDEUTET
  // — gestrichelt und auf indikativer Höhe, damit sofort sichtbar ist, dass hier
  // keine Gerade liegt. Nie ab Null: RAMP_HINT_FRAC hält den Start klar darüber.
  const rampHints: { x0: number; x1: number; y0: number; y1: number; s: number }[] = [];
  let run: string | null = null;
  phases.forEach((p) => {
    if (p.step.kind !== "flow") {
      if (run) flowPaths.push(run);
      run = null;
      return;
    }
    const target = p.step.targetFlowGs;
    if (run === null) {
      const tPlateau = p.tStart + p.rampS;
      const yEntry = p.rampS > 0 ? yF(target * RAMP_HINT_FRAC) : yF(target);
      if (p.rampS > 0) {
        rampHints.push({
          x0: x(p.tStart),
          x1: x(tPlateau),
          y0: yEntry,
          y1: yF(target),
          s: p.rampS,
        });
      }
      run = `M ${x(tPlateau).toFixed(1)} ${yF(target).toFixed(1)}`;
      entryDots.push({ cx: x(p.tStart), cy: yEntry });
    } else if (p.rampS > 0) {
      run += ` L ${x(p.tStart + p.rampS).toFixed(1)} ${yF(target).toFixed(1)}`;
    } else {
      run += ` L ${x(p.tStart).toFixed(1)} ${yF(target).toFixed(1)}`;
    }
    run += ` L ${x(p.tEnd).toFixed(1)} ${yF(target).toFixed(1)}`;
  });
  if (run) flowPaths.push(run);

  const lastPhase = phases[phases.length - 1];
  const lastConds = exitConditions(lastPhase.step.exit);
  const masterG = lastPhase.step.exit.weightG ?? yieldTargetG;
  const masterText = masterG != null ? `${de(masterG)} g` : null;

  const hasFlow = steps.some((s) => s.kind === "flow");
  const hasPower = steps.some((s) => s.kind === "power");
  const hasPressure = steps.some((s) => s.kind === "pressure");

  // Rampenstart einer Druck-/Power-Phase ist der letzte Sollwert DERSELBEN Art
  // (FlowHoldDriver: stageRampFrom = lastPressureTarget/lastPowerTarget), nicht
  // die Grundlinie — sonst zeichnet sich eine fallende Rampe als Anstieg.
  const lastFrac = { pressure: 0, power: 0 };
  const secSegments = phases.map((p) => {
    // Die Preinfusion hat keinen festen Sollwert — sie folgt dem Druck (Kennlinie).
    if (p.step.kind === "flow" || p.step.kind === "preinfusion") return null;
    const step = p.step;
    const frac =
      step.kind === "power"
        ? step.power / 100
        : Math.min(1, step.targetPressureBar / BAR_SCALE_MAX);
    const fromFrac = p.rampS > 0 ? lastFrac[step.kind] : frac;
    lastFrac[step.kind] = frac;
    return { p, step, frac, fromFrac };
  });

  // Uebergabe zwischen den Regelgroessen: die Leistungslinie laeuft auf einer
  // andeutenden Eigenskala, die Flow-Linie in g/s. Sie koennen nicht ineinander
  // uebergehen, ohne dass eine von beiden etwas Falsches behauptet. Deshalb ein
  // neutraler Verbinder statt einer erfundenen Durchgaengigkeit: er sagt "hier
  // wechselt die Regelgroesse", ohne einen Wert zu suggerieren.
  const handovers: { x: number; y0: number; y1: number }[] = [];
  phases.forEach((p, i) => {
    const next = phases[i + 1];
    if (!next || next.step.kind !== "flow" || p.step.kind === "flow") return;
    const sg = secSegments[i];
    if (!sg) return;
    const yPower = B - sg.frac * (B - T);
    const yFlow = next.rampS > 0
      ? yF(next.step.kind === "flow" ? next.step.targetFlowGs * RAMP_HINT_FRAC : 0)
      : yF(next.step.kind === "flow" ? next.step.targetFlowGs : 0);
    handovers.push({ x: x(p.tEnd), y0: yPower, y1: yFlow });
  });

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        fontFamily="'DM Sans', system-ui, sans-serif"
        style={{ display: "block", width: "100%", height: "auto" }}
      >
        {/* Phasen-Bänder */}
        {phases.map((p, i) => (
          <rect
            key={`band-${i}`}
            x={x(p.tStart).toFixed(1)}
            y={T}
            width={(x(p.tEnd) - x(p.tStart)).toFixed(1)}
            height={B - T}
            fill={BAND_FILL[p.step.kind]}
          />
        ))}

        {/* Raster: Grundlinie + wenige Hilfslinien */}
        <g stroke={C.bdr} strokeWidth={1}>
          <line x1={L} y1={B} x2={R} y2={B} />
          {hasFlow &&
            ticks.map((g) => (
              <line key={`grid-${g}`} x1={L} y1={yF(g).toFixed(1)} x2={R} y2={yF(g).toFixed(1)} />
            ))}
        </g>
        {/* Die Achse gehört dem Flow. Ohne Flow-Phase gibt es nichts zu skalieren —
            Druck läuft auf indikativer Eigenskala, eine g/s-Achse wäre gelogen. */}
        {hasFlow && (
          <g fill={C.mut} fontSize={10}>
            {ticks.map((g) => (
              <text key={`ty-${g}`} x={L - 8} y={(yF(g) + 3).toFixed(1)} textAnchor="end">
                {gridStep < 1 ? fmt1(g) : de(g)}
              </text>
            ))}
            <text x={L - 8} y={B + 3} textAnchor="end">0</text>
            <text x={L} y={T - 12}>g/s</text>
          </g>
        )}

        {/* Phasengrenzen */}
        <g stroke={C.bdr2} strokeWidth={1}>
          {phases.slice(1).map((p, i) => (
            <line key={`div-${i}`} x1={x(p.tStart).toFixed(1)} y1={T} x2={x(p.tStart).toFixed(1)} y2={B} />
          ))}
        </g>

        {/* Power-/Druck-Soll auf indikativer Eigenskala */}
        {secSegments.map((sg, i) => {
          if (sg === null) return null;
          const { p, step, frac, fromFrac } = sg;
          const col = KIND_COLOR[step.kind];
          const yTop = B - frac * (B - T);
          const yFrom = B - fromFrac * (B - T);
          const x0 = x(p.tStart);
          const x1 = x(p.tEnd);
          const xr = x(p.tStart + p.rampS);
          const line = `M ${x0.toFixed(1)} ${yFrom.toFixed(1)} L ${xr.toFixed(1)} ${yTop.toFixed(1)} L ${x1.toFixed(1)} ${yTop.toFixed(1)}`;
          return (
            <g key={`sec-${i}`}>
              <path
                d={`${line} L ${x1.toFixed(1)} ${B} L ${x0.toFixed(1)} ${B} Z`}
                fill={col}
                fillOpacity={0.07}
              />
              <path
                d={line}
                fill="none"
                stroke={col}
                strokeWidth={2}
                strokeDasharray="5 3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {/* Bei 100 % liegt das Plateau an der Oberkante — dort steht schon
                  der Phasenname. Dann wandert der Wert unter die Linie statt
                  darueber, sonst ueberlagern sich beide. */}
              <text
                x={((x0 + x1) / 2).toFixed(1)}
                y={(yTop - 8 > T + 4 ? yTop - 8 : yTop + 15).toFixed(1)}
                fill={col}
                fontSize={11}
                fontWeight={600}
                textAnchor="middle"
              >
                {step.kind === "power" ? `${de(step.power)} %` : `${de(step.targetPressureBar)} bar`}
              </text>
            </g>
          );
        })}

        {/* Angedeutete Einstiegsrampe: gestrichelte Schräge auf das Ziel. Die
            Steigung ist indikativ (Startwert = gemessener Ist-Flow). */}
        {rampHints.map((r, i) => (
          <g key={`ramp-${i}`}>
            <line
              x1={r.x0.toFixed(1)}
              y1={r.y0.toFixed(1)}
              x2={r.x1.toFixed(1)}
              y2={r.y1.toFixed(1)}
              stroke={SOLL}
              strokeWidth={2.75}
              strokeDasharray="5 4"
              strokeLinecap="round"
              opacity={0.6}
            />
            {/* Am FUSS der Rampe, nach rechts laufend: die Rampe steigt nach
                rechts, der Text laeuft also von ihr weg. Mittig gesetzt lag er
                unabhaengig vom Abstand immer auf der Linie. */}
            <text
              x={(r.x0 + 8).toFixed(1)}
              y={(r.y0 + 15).toFixed(1)}
              fill={SOLL}
              fontSize={9}
              opacity={0.75}
              textAnchor="start"
            >
              {de(r.s)} s ab Ist-Flow
            </text>
          </g>
        ))}

        {/* Uebergabe der Regelgroesse — neutral, kein Wert */}
        {handovers.map((h, i) => (
          // Endmarken, damit der Verbinder nicht mit der Phasentrennlinie
          // verschmilzt — die liegt an derselben Stelle.
          <g key={`ho-${i}`} stroke={C.mut} strokeWidth={1.4} opacity={0.9}>
            <line x1={h.x.toFixed(1)} y1={h.y0.toFixed(1)} x2={h.x.toFixed(1)} y2={h.y1.toFixed(1)} strokeDasharray="3 3" />
            <line x1={(h.x - 5).toFixed(1)} y1={h.y0.toFixed(1)} x2={(h.x + 5).toFixed(1)} y2={h.y0.toFixed(1)} />
            <line x1={(h.x - 5).toFixed(1)} y1={h.y1.toFixed(1)} x2={(h.x + 5).toFixed(1)} y2={h.y1.toFixed(1)} />
          </g>
        ))}

        {/* Flow-Soll-Treppe */}
        {flowPaths.map((d, i) => (
          <path
            key={`flow-${i}`}
            d={d}
            fill="none"
            stroke={SOLL}
            strokeWidth={2.75}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {entryDots.map((dot, i) => (
          <circle
            key={`dot-${i}`}
            cx={dot.cx.toFixed(1)}
            cy={dot.cy.toFixed(1)}
            r={3.2}
            fill={C.bg}
            stroke={SOLL}
            strokeWidth={2}
          />
        ))}

        {/* Ziel-Werte über den Plateaus */}
        <g fontSize={11} fontWeight={600} textAnchor="middle" fill={SOLL}>
          {phases.map((p, i) =>
            p.step.kind === "flow" ? (
              <text
                key={`tgt-${i}`}
                x={((x(p.tStart) + x(p.tEnd)) / 2).toFixed(1)}
                y={(yF(p.step.targetFlowGs) - 9).toFixed(1)}
              >
                {fmt1(p.step.targetFlowGs)}
              </text>
            ) : null,
          )}
        </g>

        {/* Phasennamen, nach Typ eingefärbt */}
        <g fontSize={10.5} fontWeight={600} textAnchor="middle" opacity={0.85}>
          {phases.map((p, i) => (
            <text
              key={`nm-${i}`}
              x={((x(p.tStart) + x(p.tEnd)) / 2).toFixed(1)}
              y={T - 12}
              fill={KIND_COLOR[p.step.kind]}
            >
              {stepLabel(p.step)}
            </text>
          ))}
        </g>

        {/* Exit-Bedingungen an den Grenzen, dezent */}
        <g fontSize={9.5} textAnchor="middle">
          {phases.slice(0, -1).map((p, i) => {
            const conds = exitConditions(p.step.exit);
            if (conds.length === 0) return null;
            return (
              <g key={`ex-${i}`}>
                <text x={x(p.tEnd).toFixed(1)} y={B + 16} fill={C.txtS}>
                  {conds[0]}
                </text>
                {conds.length > 1 && (
                  <text x={x(p.tEnd).toFixed(1)} y={B + 28} fill={C.mut} fontSize={9}>
                    oder {conds[1]}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {/* Abschluss rechts: Ziel-Stopp bzw. Exit der letzten Phase */}
        <g textAnchor="end">
          {masterText !== null ? (
            <>
              <text x={R} y={B + 16} fill={SOLL} fontSize={9.5} fontWeight={600}>
                → {masterText}
              </text>
              <text x={R} y={B + 28} fill={C.mut} fontSize={9}>
                Master-Stop
              </text>
            </>
          ) : (
            lastConds[0] && (
              <text x={R} y={B + 16} fill={C.txtS} fontSize={9.5}>
                {lastConds[0]}
              </text>
            )
          )}
        </g>

        <text x={R} y={B + 44} fill={C.dim} fontSize={9.5} textAnchor="end">
          t nominal (geschätzt), s
        </text>
      </svg>

      <div
        style={{
          display: "flex",
          gap: "7px 16px",
          flexWrap: "wrap",
          fontSize: 11.5,
          color: C.mut,
          marginTop: 12,
          alignItems: "center",
        }}
      >
        {hasFlow && <LegendItem swatch={SOLL}><b>Soll-Flow</b> g/s</LegendItem>}
        {hasPower && (
          <LegendItem swatch={C.seriesPower} dashed>
            <b>Power-Soll</b> % (nur Präinfusion)
          </LegendItem>
        )}
        {hasPressure && (
          <LegendItem swatch={C.seriesPressure} dashed>
            <b>Druck-Soll</b> bar
          </LegendItem>
        )}
        {hasFlow && <LegendItem box={alpha(C.seriesFlow, 0.14)}>Flow-Phase</LegendItem>}
        {hasPower && <LegendItem box={alpha(C.seriesPower, 0.16)}>Power-Phase</LegendItem>}
      </div>
    </div>
  );
}

function LegendItem({
  swatch,
  dashed,
  box,
  children,
}: {
  swatch?: string;
  dashed?: boolean;
  box?: string;
  children: React.ReactNode;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
      {box !== undefined ? (
        <span style={{ width: 11, height: 11, borderRadius: 3, background: box, flex: "0 0 auto" }} />
      ) : (
        <span
          style={{
            width: 14,
            height: 0,
            borderTop: `2.5px ${dashed ? "dashed" : "solid"} ${swatch}`,
            borderRadius: 2,
            flex: "0 0 auto",
          }}
        />
      )}
      <span>{children}</span>
    </span>
  );
}
