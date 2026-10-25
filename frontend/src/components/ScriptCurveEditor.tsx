/**
 * CurveEditor — die Soll-Kurve, an der man ziehen kann: fuer Skripte und, im
 * vereinten Editor, genauso fuer App-Stufen (Schnitt 2d). Was ein Griff
 * aendert, entscheidet ein kleiner Adapter (`CurveEdit`): beim Skript die
 * Befehle (shared/script-edit.ts), bei der App genau eine Stufe
 * (shared/steps-curve.ts). Gezeichnet wird beides aus derselben Timeline-Form.
 *
 * Eigenes SVG statt Recharts: Ziehen braucht die Achsen-Umrechnung in beide
 * Richtungen (Pixel ↔ ms/bar) und Pointer-Capture, und die Achsen muessen
 * waehrend des Ziehens stillstehen — sonst rutscht die Kurve unter dem Finger
 * weg, weil die Gesamtdauer mitwaechst.
 *
 * Zwei Griffe (Modell in shared/script-edit.ts):
 *   ● Punkt am Rampenende — waagerecht = Uebergangszeit, senkrecht = Zielwert
 *   ▮ Leiste am Stufenende — waagerecht = die bestimmende Wartezeit
 *
 * Die Kurve selbst kommt unveraendert aus scriptToTimeline, wird also genau so
 * gezeichnet wie in der Ansicht und im Soll-Overlay der Historie.
 */

import { useEffect, useRef, useState } from "react";
import type { BrewStep, ParsedCmd } from "@shared/types.js";
import type { ScriptTimeline, PumpMode, ScriptPhase } from "@shared/script-timeline.js";
import {
  setPhaseTarget, setPhaseRamp, shiftPhaseEnd, phaseWaitIndex, DRAG_TIME_STEP_MS,
} from "@shared/script-edit.js";
import { setStepPoint, shiftStepEnd, stepHasPoint, stepHasEnd } from "@shared/steps-curve.js";
import { t, useTranslation } from "../i18n/index.js";
import theme from "../theme.js";
import { dec } from "../lib/num.js";

const C = theme;
const MONO = "'JetBrains Mono', monospace";
const MODE_COLOR: Record<PumpMode, string> = { pressure: C.seriesPressure, flow: C.seriesFlow, power: C.seriesPower };

const DEFAULT_H = 300;
const PAD = { top: 22, bottom: 28, left: 34 };
const BAR_MAX = 12;
const FLOW_MAX = 8;

type Drag =
  | { kind: "point"; cmdIndex: number; axis: "bar" | "flow"; x0: number; y0: number; ramp0: number; target0: number }
  | { kind: "end"; cmdIndex: number; x0: number; end0: number };

/** Was die Griffe an einem Stand `T` aendern (Skript-Befehle oder App-Stufen). */
export interface CurveEdit<T> {
  /** ● Ziel und Rampe. */
  canPoint: (value: T, key: number) => boolean;
  /** ▮ Dauer. */
  canEnd: (value: T, key: number) => boolean;
  point: (base: T, key: number, axisValue: number, rampMs: number) => { next: T; text: string };
  end: (base: T, key: number, deltaMs: number) => { next: T; text: string };
}

interface Props<T> {
  value: T;
  edit: CurveEdit<T>;
  timeline: ScriptTimeline;
  /** Gewaehlte Phase: Befehlsindex (Skript) bzw. Stufenindex (App). */
  selected: number | null;
  onSelect: (key: number | null) => void;
  /** Laufende Aenderung beim Ziehen (noch nicht in der Rueckgaengig-Liste). */
  onPreview: (value: T) => void;
  /** Ziehen beendet: diesen Stand festhalten. */
  onCommit: (value: T) => void;
  /** Hoehe in px (Standard 300) — der vereinte Editor braucht sie flacher. */
  height?: number;
  /** Oberkante der Fluss-Achse rechts (Standard 8). */
  flowMax?: number;
  /** Ende nur geschaetzt (App: am Yield) — „Ende ≈ …“. */
  approxEnd?: boolean;
  /** Gemeinsames Ende aller Varianten eines Profils (ms) — die Achse reicht mindestens so weit. */
  xEndMs?: number;
}

const fmt = (v: number, digits = 1) => dec(v.toFixed(digits));

/** Skript-Befehle: Ziel/Rampe am Pumpenbefehl, Dauer an der bestimmenden Wartezeit. */
export const scriptCurveEdit: CurveEdit<ParsedCmd[]> = {
  canPoint: (cmds, i) => { const c = cmds[i]; return !!c && (c.cmd === 3 || c.cmd === 4 || c.cmd === 5); },
  canEnd: (cmds, i) => phaseWaitIndex(cmds, i) >= 0,
  point: (base, i, target, rampMs) => {
    let next = setPhaseTarget(base, i, target);
    next = setPhaseRamp(next, i, rampMs, DRAG_TIME_STEP_MS);
    const c = next[i]!;
    const val = c.cmd === 4 ? `${fmt(Number(c.args[0]) / 1000)} bar` : c.cmd === 3 ? `${c.args[0]} %` : `${fmt(Number(c.args[0]))} ml/s`;
    return { next, text: t("scriptEditor.curve.pointBubble", { value: val, s: fmt(Number(c.args[1]) / 1000) }) };
  },
  end: (base, i, deltaMs) => {
    const next = shiftPhaseEnd(base, i, deltaMs, DRAG_TIME_STEP_MS);
    const w = phaseWaitIndex(next, i);
    return { next, text: t("scriptEditor.curve.waitBubble", { s: fmt(Number(next[w]!.args[0]) / 1000) }) };
  },
};

/** App-Stufen: Ziel/Rampe und Zeit-Ausstieg genau einer Stufe. */
export const stepsCurveEdit: CurveEdit<BrewStep[]> = {
  canPoint: (steps, i) => !!steps[i] && stepHasPoint(steps[i]!),
  canEnd: (steps, i) => stepHasEnd(steps, i),
  point: (base, i, target, rampMs) => {
    const next = setStepPoint(base, i, target, rampMs, DRAG_TIME_STEP_MS);
    const s = next[i]!;
    const val = s.kind === "pressure" ? `${fmt(s.targetPressureBar)} bar` : s.kind === "flow" ? `${fmt(s.targetFlowGs)} g/s` : s.kind === "power" ? `${s.power} %` : "";
    return { next, text: t("scriptEditor.curve.pointBubble", { value: val, s: fmt((s.rampMs ?? 0) / 1000) }) };
  },
  end: (base, i, deltaMs) => {
    const next = shiftStepEnd(base, i, deltaMs, DRAG_TIME_STEP_MS);
    return { next, text: t("scriptEditor.curve.afterBubble", { s: fmt(next[i]!.exit.seconds ?? 0) }) };
  },
};

/** Die Skript-Kurve (Skript-Varianten im Profil-Editor). */
export function ScriptCurveEditor({ cmds, ...rest }: Omit<Props<ParsedCmd[]>, "value" | "edit"> & { cmds: ParsedCmd[] }) {
  return <CurveEditor value={cmds} edit={scriptCurveEdit} {...rest} />;
}

export function CurveEditor<T>({ value, edit, timeline, selected, onSelect, onPreview, onCommit, height = DEFAULT_H, flowMax = FLOW_MAX, approxEnd = false, xEndMs }: Props<T>) {
  useTranslation(); // neu zeichnen beim Sprachwechsel (Texte über das Modul-`t`)
  const H = height;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.floor(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [drag, setDrag] = useState<Drag | null>(null);
  const baseRef = useRef<T | null>(null);
  const lastRef = useRef<T | null>(null);
  const [bubble, setBubble] = useState<{ x: number; y: number; text: string } | null>(null);

  // Achsen: waehrend des Ziehens eingefroren.
  // Achsenende: diese Kurve, mindestens aber das gemeinsame Ende aller Varianten
  // (xEndMs) — sonst skaliert die Achse beim Variantenwechsel neu und die Kurve springt.
  const endForAxis = Math.max(timeline.totalMs, xEndMs ?? 0);
  const liveXMax = Math.max(endForAxis + 5000, endForAxis * 1.1, 10_000);
  const [frozenXMax, setFrozenXMax] = useState<number | null>(null);
  const xMax = frozenXMax ?? liveXMax;
  const hasFlow = timeline.phases.some((p) => p.axis === "flow" && !p.noWait);
  const padRight = hasFlow ? 34 : 14;
  const plotW = width - PAD.left - padRight;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (ms: number) => PAD.left + (ms / xMax) * plotW;
  const yBar = (v: number) => PAD.top + plotH - (v / BAR_MAX) * plotH;
  const yFlow = (v: number) => PAD.top + plotH - (v / flowMax) * plotH;
  const y = (axis: "bar" | "flow", v: number) => (axis === "flow" ? yFlow(v) : yBar(v));
  const msPerPx = xMax / plotW;

  const live = timeline.phases.filter((p) => !p.noWait);

  // --- Ziehen ---------------------------------------------------------------

  const start = (e: React.PointerEvent, d: Drag) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    baseRef.current = value;
    lastRef.current = value;
    setFrozenXMax(xMax);
    setDrag(d);
    onSelect(d.cmdIndex);
  };

  const move = (e: React.PointerEvent) => {
    if (!drag || !baseRef.current) return;
    const base = baseRef.current;
    const dxMs = (e.clientX - drag.x0) * msPerPx;
    let r: { next: T; text: string };
    if (drag.kind === "point") {
      const unitsPerPx = (drag.axis === "flow" ? flowMax : BAR_MAX) / plotH;
      const target = drag.target0 - (e.clientY - drag.y0) * unitsPerPx;
      r = edit.point(base, drag.cmdIndex, target, drag.ramp0 + dxMs);
    } else {
      r = edit.end(base, drag.cmdIndex, dxMs);
    }
    const { next, text } = r;
    lastRef.current = next;
    onPreview(next);
    const rect = (e.currentTarget as Element).closest("svg")!.getBoundingClientRect();
    setBubble({ x: e.clientX - rect.left, y: e.clientY - rect.top, text });
  };

  const end = () => {
    if (!drag) return;
    const last = lastRef.current;
    const base = baseRef.current;
    setDrag(null);
    setBubble(null);
    setFrozenXMax(null);
    baseRef.current = null;
    lastRef.current = null;
    if (last && last !== base) onCommit(last);
  };

  // --- Zeichnen -------------------------------------------------------------

  const step = xMax <= 35_000 ? 5000 : xMax <= 100_000 ? 10_000 : 30_000;
  const xTicks: number[] = [];
  for (let t = 0; t <= xMax; t += step) xTicks.push(t);

  const phasePath = (ph: ScriptPhase) => {
    const pts: [number, number][] = [[ph.tStart, ph.startValue]];
    if (!ph.truncated && ph.rampDurMs > 0 && ph.rampEndT > ph.tStart) {
      pts.push([ph.rampEndT, ph.targetValue]);
      if (ph.tEnd > ph.rampEndT) pts.push([ph.tEnd, ph.targetValue]);
    } else {
      pts.push([ph.tEnd, ph.endValue]);
    }
    return pts.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(ph.axis, v).toFixed(1)}`).join(" ");
  };
  /** Nur das Halten ab Rampenende (die Rampe davor ist angedeutet). */
  const holdPath = (ph: ScriptPhase) =>
    `M${x(ph.rampEndT).toFixed(1)},${y(ph.axis, ph.targetValue).toFixed(1)} L${x(ph.tEnd).toFixed(1)},${y(ph.axis, ph.targetValue).toFixed(1)}`;

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%", userSelect: "none" }}>
      <svg
        width={width}
        height={H}
        style={{ display: "block", touchAction: drag ? "none" : "pan-y" }}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onClick={() => { if (!drag) onSelect(null); }}
      >
        {/* Raster */}
        {[0, 2, 4, 6, 8, 10, 12].map((v) => (
          <g key={`gy${v}`}>
            <line x1={PAD.left} x2={width - padRight} y1={yBar(v)} y2={yBar(v)} stroke={C.bdr} strokeDasharray={v ? "3 3" : undefined} />
            <text x={PAD.left - 6} y={yBar(v) + 3} fill={C.mut} fontSize={10} fontFamily={MONO} textAnchor="end">{v}</text>
          </g>
        ))}
        {hasFlow && flowTicks(flowMax).map((v) => (
          <text key={`gf${v}`} x={width - padRight + 6} y={yFlow(v) + 3} fill={C.blu} fontSize={10} fontFamily={MONO}>{dec(String(v))}</text>
        ))}
        {hasFlow && <text x={width - padRight + 6} y={PAD.top - 9} fill={C.blu} fontSize={9} fontFamily={MONO}>g/s</text>}
        {xTicks.map((t) => (
          <text key={`gx${t}`} x={x(t)} y={H - 8} fill={C.mut} fontSize={10} fontFamily={MONO} textAnchor="middle">{Math.round(t / 1000)}s</text>
        ))}
        <text x={PAD.left - 6} y={PAD.top - 9} fill={C.mut} fontSize={9} fontFamily={MONO} textAnchor="end">bar</text>

        {/* Stufen als Flaechen — antippen waehlt den Befehl */}
        {live.map((ph) => (
          <rect
            key={`band${ph.cmdIndex}`}
            x={x(ph.tStart)} y={PAD.top} width={Math.max(0, x(ph.tEnd) - x(ph.tStart))} height={plotH}
            fill={MODE_COLOR[ph.mode]} fillOpacity={selected === ph.cmdIndex ? 0.13 : 0.05}
            style={{ cursor: "pointer" }}
            onClick={(e) => { e.stopPropagation(); onSelect(ph.cmdIndex); }}
          />
        ))}

        {/* Unbestimmte Wartezeiten (Gewicht/Temperatur) — nicht massstaeblich */}
        {timeline.waits.map((w, i) => (
          <g key={`w${i}`}>
            <rect x={x(w.tStart)} y={PAD.top} width={x(w.tEnd) - x(w.tStart)} height={plotH} fill={C.acc} fillOpacity={0.08} stroke={C.bdr2} strokeDasharray="3 3" />
            <text x={(x(w.tStart) + x(w.tEnd)) / 2} y={PAD.top + plotH - 6} fill={C.mut} fontSize={9} textAnchor="middle">{w.label}</text>
          </g>
        ))}

        {/* Markierungen: Ventile, Ende */}
        {timeline.markers.filter((m) => m.kind !== "start").map((m, i) => (
          <g key={`m${i}`}>
            <line x1={x(m.t)} x2={x(m.t)} y1={PAD.top - 4} y2={PAD.top + 4} stroke={C.mut} />
            <title>{m.label}</title>
          </g>
        ))}
        <line x1={x(timeline.totalMs)} x2={x(timeline.totalMs)} y1={PAD.top} y2={PAD.top + plotH} stroke={C.bdr3} strokeDasharray="2 3" />
        <text x={x(timeline.totalMs) - 4} y={PAD.top + 10} fill={C.mut} fontSize={9} textAnchor="end">{t(approxEnd ? "scriptEditor.curve.endApprox" : "scriptEditor.curve.end", { s: Math.round(timeline.totalMs / 1000) })}</text>

        {/* Kurve — Preinfusion hat keinen Sollwert (nur die Flaeche); ein Rampenstart am
            Ist-Fluss ist nur angedeutet: gestrichelt, und nie ab Null. */}
        {live.filter((ph) => !ph.noTarget).map((ph) => (
          <g key={`p${ph.cmdIndex}`} pointerEvents="none">
            {ph.startEstimated && (
              <line x1={x(ph.tStart)} y1={y(ph.axis, ph.startValue)} x2={x(ph.rampEndT)} y2={y(ph.axis, ph.targetValue)}
                stroke={MODE_COLOR[ph.mode]} strokeWidth={2} strokeDasharray="4 4" strokeOpacity={0.7} />
            )}
            <path d={ph.startEstimated ? holdPath(ph) : phasePath(ph)} fill="none" stroke={MODE_COLOR[ph.mode]}
              strokeWidth={selected === ph.cmdIndex ? 3.5 : 2.5} strokeLinejoin="round" />
          </g>
        ))}

        {/* Griffe mit touchAction none: der Finger zieht, statt die Seite zu scrollen
            (die freie Kurvenfläche lässt senkrechtes Wischen durch, pan-y). */}
        {/* Griff: Stufenende */}
        {live.map((ph) => {
          if (!edit.canEnd(value, ph.cmdIndex)) return null;
          const gx = x(ph.tEnd);
          const active = drag?.kind === "end" && drag.cmdIndex === ph.cmdIndex;
          return (
            <g key={`e${ph.cmdIndex}`} style={{ cursor: "ew-resize", touchAction: "none" }}
              onPointerDown={(e) => start(e, { kind: "end", cmdIndex: ph.cmdIndex, x0: e.clientX, end0: ph.tEnd })}
              onClick={(e) => e.stopPropagation()}>
              <rect x={gx - 14} y={PAD.top} width={28} height={plotH} fill="transparent" />
              <line x1={gx} x2={gx} y1={PAD.top} y2={PAD.top + plotH} stroke={active ? C.acc : C.bdr3} strokeWidth={active ? 2 : 1} strokeDasharray={active ? undefined : "4 3"} />
              <rect x={gx - 4} y={PAD.top + plotH - 30} width={8} height={24} rx={3} fill={active ? C.acc : C.cardElev} stroke={C.acc} strokeWidth={1.5} />
            </g>
          );
        })}

        {/* Griff: Rampenende / Zielwert */}
        {live.map((ph) => {
          if (!edit.canPoint(value, ph.cmdIndex)) return null;
          const hx = x(ph.tStart + ph.rampDurMs);
          const hy = y(ph.axis, ph.targetValue);
          const active = drag?.kind === "point" && drag.cmdIndex === ph.cmdIndex;
          const sel = selected === ph.cmdIndex;
          return (
            <g key={`h${ph.cmdIndex}`} style={{ cursor: "grab", touchAction: "none" }}
              onPointerDown={(e) => start(e, {
                kind: "point", cmdIndex: ph.cmdIndex, axis: ph.axis, x0: e.clientX, y0: e.clientY,
                ramp0: ph.rampDurMs, target0: ph.targetValue,
              })}
              onClick={(e) => e.stopPropagation()}>
              {ph.truncated && (
                <line x1={x(ph.tEnd)} y1={y(ph.axis, ph.endValue)} x2={hx} y2={hy} stroke={MODE_COLOR[ph.mode]} strokeDasharray="3 3" strokeOpacity={0.6} />
              )}
              <circle cx={hx} cy={hy} r={18} fill="transparent" />
              <circle cx={hx} cy={hy} r={active || sel ? 8 : 6.5} fill={active ? MODE_COLOR[ph.mode] : C.cardElev} stroke={MODE_COLOR[ph.mode]} strokeWidth={2.5} />
            </g>
          );
        })}
      </svg>

      {bubble && (
        <div style={{
          position: "absolute", left: Math.min(bubble.x + 14, width - 190), top: Math.max(0, bubble.y - 38),
          background: C.cardElev, border: `1px solid ${C.bdrL}`, borderRadius: 8, padding: "5px 9px",
          fontFamily: MONO, fontSize: 12, color: C.txt, pointerEvents: "none", whiteSpace: "nowrap",
        }}>
          {bubble.text}
        </div>
      )}
    </div>
  );
}

/** Beschriftung der Fluss-Achse: 0,5er-Schritte bis 3 g/s, darueber ganze bzw. 2er. */
function flowTicks(max: number): number[] {
  const step = max <= 3 ? 0.5 : max <= 6 ? 1 : 2;
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(Math.round(v * 10) / 10);
  return out;
}
