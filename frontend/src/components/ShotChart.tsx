/**
 * ShotChart — Phase 1 Step 7.
 *
 * Always visible on Dashboard in three modes:
 *   idle    → empty axes, legend shows "—" for all values
 *   brewing → live samples stream in, legend shows avg values
 *   ended   → DB-authoritative samples, legend shows avg/final values
 *
 * Axis strategy:
 *   Y-left  ("main", domain 0-12): pressure (bar) + flow (g/s) — similar ranges
 *   Y-right ("temp", domain 60-100): brew group temp (°C), hidden on mobile
 *
 *   Weight is rendered on the left axis scaled by (12 / yWeightMax):
 *     e.g. 36g with yWeightMax=50 → y = 36 × 0.24 = 8.64 (≈ same height as 9 bar)
 *   The left Y-axis is labelled "bar" — it is a proportional reference, NOT
 *   a reading axis for weight. Live values are read from the legend, not the scale.
 *
 * Legend (top-left): coloured line marker + label + AVG VALUE in real units
 *   (except Weight which shows the final/last value).
 * LIVE badge (top-right): pulsing dot, only during brewing.
 * Tooltip on hover: all 4 values in real units for the hovered time point.
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
  ResponsiveContainer,
  Customized,
} from "recharts";
import { ShotGhostLayer } from "./ShotGhostLayer.js";
import type { ShotGhosts } from "../hooks/useShotGhosts.js";
import type { ChartSample } from "../hooks/useShotSamples.js";
import type { ChartXSettings } from "../hooks/useChartSettings.js";
import { chartXDomain, fixedXTicks, liveDisplayT, trimToDisplayTime } from "@shared/chart-x-domain.js";
import type { StageStrip as StageStripData } from "@shared/stage-strip.js";
import { StageStrip } from "./StageStrip.js";
import theme, { alpha } from "../theme";

const C = theme;

// ---------------------------------------------------------------------------
// Chart colours (Handoff 5.7 + Step 7 spec)
// ---------------------------------------------------------------------------

const COLOR = {
  pressure: C.seriesPressure,
  flow:     C.seriesFlow,
  temp:     C.seriesTemp,
  weight:   C.seriesWeight,
} as const;

// SO-1: commanded "Soll" overlay lines — light green, distinct from all measured series.
const SOLL_GREEN = C.seriesTarget;
// Flow-Hold stage entries that really happened — a stronger green than the Soll curve.
const STAGE_GREEN = C.seriesStage;
// Phase bands (History detail): pre-infusion amber, extraction blue.
const BAND_PREINFUSION = alpha(C.seriesPower, 0.05);
const BAND_EXTRACTION = alpha(C.seriesFlow, 0.035);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChartMode = "idle" | "brewing" | "ended";

interface ShotChartProps {
  samples: ChartSample[];
  mode: ChartMode;
  /** Yield target in grams — renders a dashed horizontal reference line. */
  yieldTarget?: number | null;
  /** Max weight for scaling weight to the left axis. Default 50g. */
  yWeightMax?: number;
  /** Show temp Y axis (right side). Hidden on mobile. */
  showTempAxis?: boolean;
  /** X-axis sliding-window settings from backend. Falls back to safe defaults. */
  xSettings?: ChartXSettings;
  /** Plot height in px. Used only when `fill` is false. Default 220. */
  chartHeight?: number;
  /** Fill the parent's height (flex) instead of a fixed px height (Dashboard). */
  fill?: boolean;
  /** Show the "Bezug beendet" badge in ended mode (auto-hides after 3s).
   *  Off for static views like the history detail modal. Default true. */
  endedBadge?: boolean;
  /** Pre-infusion → extraction transition (seconds). Shades [0, t] and marks the
   *  boundary. null/≤0 → no band (no pre-infusion captured). History detail. */
  preinfusionEndS?: number | null;
  /** Show the measured pump-power (%) curve (scaled to the left axis). History detail. */
  showPump?: boolean;
  /** SO-1: commanded "Soll" overlay (History detail). Points in SECONDS, values
   *  in axis units (bar / ml/s). Drawn dashed over the measured lines. */
  overlay?: ShotChartOverlay | null;
  /** Flow-Hold stage overlay (History detail): the green Soll flow staircase of
   *  the stages that actually ran, faint ghost lines for planned-but-never-run
   *  stages, and vertical markers at the real stage entries. */
  stageOverlay?: ShotChartStageOverlay | null;
  /** Past shots of the same brew, drawn faintly behind this one. Finished shots
   *  only — see ShotGhostLayer for why there is no live variant. */
  ghosts?: ShotGhosts | null;
  /** Stufenleiste unter der Kurve (History-Detail): teilt die x-Achse des Diagramms. */
  stageStrip?: { strip: StageStripData; firstDropS: number | null } | null;
}

export interface ShotChartStageOverlay {
  /** Green Soll staircase for the flow stages that ran (seconds, v in g/s). */
  flowSoll: { t: number; v: number }[];
  /** Faint continuation staircase of planned flow stages that never ran. */
  ghostSoll: { t: number; v: number }[];
  /** Vertical markers at real stage entries (seconds + short label). */
  markers: { t: number; label: string }[];
  /** Weight master stop — solid green vertical line with label. */
  masterStop: { t: number; label: string } | null;
}

export interface ShotChartOverlay {
  barSolid: { t: number; v: number }[];
  barHeld: { t: number; v: number }[];
  flowSolid: { t: number; v: number }[];
  flowHeld: { t: number; v: number }[];
  /** Vertical markers (determinism end / stop), in seconds. */
  markers: { t: number; label: string }[];
  /** Soll total length in seconds — extends the x-domain so the held part shows. */
  endT: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AXIS_TICK = {
  fill: C.mut,
  fontSize: 10,
  fontFamily: "'JetBrains Mono', monospace",
};

const Y_LEFT_MAX = 12;
// Achsbreiten und Raender der Plotflaeche — die Stufenleiste richtet sich danach aus.
const Y_LEFT_WIDTH = 28;
const Y_RIGHT_WIDTH = 32;
const RIGHT_MARGIN_TEMP = 36;
const RIGHT_MARGIN_PLAIN = 4;
/** Messreihen, deren letztes Stueck live bis zur Anzeige-Uhr gezogen wird. */
const LIVE_KEYS = ["pressure", "flow", "temp", "weight", "pump"] as const;

/** Scale weight grams to the left axis (0-12 range). */
function scaleWeight(g: number, yWeightMax: number): number {
  return g * (Y_LEFT_MAX / yWeightMax);
}

function fmt(v: number | null | undefined, decimals: number): string {
  if (v === null || v === undefined) return "—";
  return v.toFixed(decimals);
}

// ---------------------------------------------------------------------------
// Custom Tooltip
// ---------------------------------------------------------------------------

interface TooltipPayloadEntry {
  name: string;
  value: number;
  color: string;
}

interface CustomTooltipProps {
  active?: boolean;
  label?: number;
  payload?: TooltipPayloadEntry[];
  yWeightMax: number;
}

function CustomTooltip({ active, label, payload, yWeightMax }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  // Build a map from series name to value
  const byName: Record<string, number> = {};
  for (const p of payload) {
    if (p.value !== null && p.value !== undefined) {
      byName[p.name] = p.value;
    }
  }

  const rows: { label: string; value: string; unit: string; color: string }[] = [
    {
      label: "Druck",
      value: fmt(byName["pressure"] ?? null, 1),
      unit: "bar",
      color: COLOR.pressure,
    },
    {
      label: "Flow",
      value: fmt(byName["flow"] ?? null, 2),
      unit: "g/s",
      color: COLOR.flow,
    },
    {
      label: "Temp BG",
      value: fmt(byName["temp"] ?? null, 1),
      unit: "°C",
      color: COLOR.temp,
    },
    {
      label: "Gewicht",
      // Weight is stored scaled — convert back to grams for display
      value: byName["weight"] !== undefined
        ? fmt(byName["weight"] / (Y_LEFT_MAX / yWeightMax), 1)
        : "—",
      unit: "g",
      color: COLOR.weight,
    },
  ];

  // Pump curve only present when toggled on — unscale back to %.
  if (byName["pump"] !== undefined) {
    rows.push({
      label: "Pumpe",
      value: fmt((byName["pump"] * 100) / Y_LEFT_MAX, 0),
      unit: "%",
      color: C.seriesPower,
    });
  }

  return (
    <div
      style={{
        background: C.cardElev,
        border: `1px solid ${C.bdr}`,
        borderRadius: 8,
        padding: "8px 12px",
        fontSize: 11,
        fontFamily: "'JetBrains Mono', monospace",
        color: C.txt,
        boxShadow: `0 8px 24px ${alpha(C.black, 0.4)}`,
        minWidth: 130,
      }}
    >
      <div style={{ color: C.mut, marginBottom: 6, fontFamily: "'DM Sans', sans-serif" }}>
        {fmt(label ?? null, 1)}s
      </div>
      {rows.map((r) => (
        <div key={r.label} style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 2 }}>
          <span style={{ color: r.color }}>{r.label}</span>
          <span>{r.value !== "—" ? `${r.value} ${r.unit}` : "—"}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
//
// Wrapped in React.memo with a custom comparator that re-renders when the
// samples array identity changes (the hook swaps the reference only on a real
// content change — incl. the end-of-shot swap to DB-authoritative samples that
// may share the live length), or when any scalar prop changes.
// ---------------------------------------------------------------------------

function ShotChartInner({
  samples,
  mode,
  yieldTarget,
  yWeightMax = 50,
  showTempAxis = true,
  xSettings,
  chartHeight = 220,
  fill = false,
  endedBadge = true,
  overlay = null,
  stageOverlay = null,
  preinfusionEndS = null,
  showPump = false,
  ghosts = null,
  stageStrip = null,
}: ShotChartProps) {
  const windowS         = xSettings?.window          ?? 30;
  const slideStepS      = xSettings?.slideStep        ?? 10;
  const resizeOnEnd     = xSettings?.resizeOnEnd      ?? true;
  const resizeAnimation = xSettings?.resizeAnimation  ?? true;
  const grow            = xSettings?.grow             ?? true;

  // Build data for Recharts — weight is pre-scaled to the left axis range.
  // Keep the array reference stable between appended samples to avoid chart jitter.
  // Key on the samples array identity (not just its length): when a shot ends,
  // the live samples are atomically replaced by the DB-authoritative ones, which
  // may have the SAME length but corrected (sanitized/post-brew) values. Keying
  // on length alone would skip that recompute. The hook only swaps the reference
  // on a genuine content change (live append, dedup-replace, DB swap).
  const data = useMemo(() => samples.map((s) => ({
    t: s.t,
    pressure: s.pressure,
    flow: s.flow,
    // Temp goes on right axis — keep raw °C value
    temp: s.temp,
    // Weight scaled to left axis (0-12 range)
    weight: s.weight !== null ? parseFloat(scaleWeight(s.weight, yWeightMax).toFixed(3)) : null,
    // Pump power % scaled to the left axis (100% → Y_LEFT_MAX). Shape indicator.
    pump: s.pumpPwm !== null ? parseFloat((s.pumpPwm * (Y_LEFT_MAX / 100)).toFixed(3)) : null,
  })), [samples, yWeightMax]);

  // SO-1: merge the commanded Soll overlay points into the chart data (own t
  // values, own keys; measured rows keep theirs). Recharts draws each series
  // across the rows where its key is defined (connectNulls).
  // Live waechst die Kurve stetig: eine Anzeige-Uhr laeuft LIVE_LAG_S hinter
  // der echten Zeit her, das letzte Stueck jeder Kurve wird bis zu ihr gezogen
  // (shared/chart-x-domain.ts, trimToDisplayTime). Die Zahlen ueber dem
  // Diagramm bleiben live — verzoegert ist nur die Linie.
  const lastT = samples.length > 0 ? samples[samples.length - 1].t : 0;
  const lastTRef = useRef(lastT);
  const sampleAtRef = useRef(performance.now());
  useLayoutEffect(() => {
    lastTRef.current = lastT;
    sampleAtRef.current = performance.now();
  }, [lastT]);
  const [displayT, setDisplayT] = useState<number | null>(null);
  useEffect(() => {
    if (mode !== "brewing") { setDisplayT(null); return; }
    // 20 Bilder/s: das Tablet zeichnet das ganze Diagramm bei jedem Schritt neu.
    const tick = () => setDisplayT(liveDisplayT(lastTRef.current + (performance.now() - sampleAtRef.current) / 1000));
    tick();
    const id = window.setInterval(tick, 50);
    return () => window.clearInterval(id);
  }, [mode]);
  const live = mode === "brewing" && displayT !== null ? trimToDisplayTime(data, displayT, LIVE_KEYS) : null;
  const shownData = live ? live.rows : data;

  const chartData = useMemo(() => {
    if (!overlay && !stageOverlay) return shownData as Record<string, number | null>[];
    const rows: Record<string, number | null>[] = shownData.map((d) => ({ ...d }));
    if (overlay) {
      for (const p of overlay.barSolid) rows.push({ t: p.t, sollBar: p.v });
      for (const p of overlay.barHeld) rows.push({ t: p.t, sollBarHeld: p.v });
      for (const p of overlay.flowSolid) rows.push({ t: p.t, sollFlow: p.v });
      for (const p of overlay.flowHeld) rows.push({ t: p.t, sollFlowHeld: p.v });
    }
    if (stageOverlay) {
      for (const p of stageOverlay.flowSoll) rows.push({ t: p.t, stageFlowSoll: p.v });
      for (const p of stageOverlay.ghostSoll) rows.push({ t: p.t, stageGhostSoll: p.v });
    }
    rows.sort((a, b) => (a.t as number) - (b.t as number));
    return rows;
  }, [shownData, overlay, stageOverlay]);

  // Those overlay rows carry only their own key, so every measured series reads
  // a null at that x — without bridging, switching an overlay on shreds the
  // pressure/flow/temp/pump curves into segments.
  const bridgeOverlayGaps = overlay !== null || stageOverlay !== null;

  // ---------------------------------------------------------------------------
  // X domain — Schiebefenster oder mitwachsende Achse (Schalter chart_x_grow).
  // Die Rechnung selbst steht getestet in shared/chart-x-domain.ts.
  // ---------------------------------------------------------------------------

  // Live: das Kurvenende ist die rechte Kante (stauchende Achse fuellt immer).
  const elapsed = live ? live.tipT : lastT;

  const { min: targetXMin, max: targetXMax } = useMemo(
    () => chartXDomain({
      elapsed, mode, grow, windowS, slideStepS, resizeOnEnd,
      overlayEndT: overlay ? overlay.endT : null,
    }),
    [elapsed, mode, grow, windowS, slideStepS, resizeOnEnd, overlay],
  );

  // Animated current domain — ease-out-cubic over 300ms.
  // Uses refs to read the true mid-animation values as animation start points,
  // avoiding stale-closure captures of React state snapshots.
  // Startwert = Ziel, sonst animiert die Achse beim Oeffnen erst von 30 s auf 15 s.
  const currentXRef = useRef({ min: targetXMin, max: targetXMax });
  const [currentX, setCurrentX] = useState({ min: targetXMin, max: targetXMax });
  const xRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (xRafRef.current !== null) {
      cancelAnimationFrame(xRafRef.current);
      xRafRef.current = null;
    }

    const startMin = currentXRef.current.min;
    const startMax = currentXRef.current.max;
    const deltaMin = targetXMin - startMin;
    const deltaMax = targetXMax - startMax;

    if (Math.abs(deltaMin) < 0.01 && Math.abs(deltaMax) < 0.01) return;

    // Live bei stauchender Achse folgt die Achse direkt dem Kurvenende (xDomain
    // unten) — nur den Startpunkt fuer die Zoom-Animation am Ende mitfuehren.
    if (grow && mode === "brewing") {
      currentXRef.current = { min: targetXMin, max: targetXMax };
      return;
    }

    // Sofort setzen statt animieren: am Ende ohne Zoom-Animation, und bei
    // stauchender Achse immer (am Bezugsende waechst sie nur um den Rand; die
    // Zoom-Schalter sind dort ausgeblendet und sollen nichts bewirken).
    if ((mode === "ended" && resizeOnEnd && !resizeAnimation) || grow) {
      const v = { min: targetXMin, max: targetXMax };
      currentXRef.current = v;
      setCurrentX(v);
      return;
    }

    const startTime = performance.now();
    const duration = 300;

    const tick = (): void => {
      const t = Math.min((performance.now() - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const v = { min: startMin + deltaMin * eased, max: startMax + deltaMax * eased };
      currentXRef.current = v;
      setCurrentX(v);
      if (t < 1) {
        xRafRef.current = requestAnimationFrame(tick);
      } else {
        xRafRef.current = null;
      }
    };
    xRafRef.current = requestAnimationFrame(tick);

    return () => {
      if (xRafRef.current !== null) {
        cancelAnimationFrame(xRafRef.current);
        xRafRef.current = null;
      }
    };
  }, [targetXMin, targetXMax]); // eslint-disable-line react-hooks/exhaustive-deps

  const xDomain = grow && mode === "brewing" ? { min: targetXMin, max: targetXMax } : currentX;

  // Scaled target reference line Y position
  const targetY = yieldTarget !== null && yieldTarget !== undefined
    ? parseFloat(scaleWeight(yieldTarget, yWeightMax).toFixed(3))
    : null;

  // "Bezug beendet" badge: show on entering ended mode, auto-hide after 3s.
  const [endedBadgeShown, setEndedBadgeShown] = useState(false);
  useEffect(() => {
    if (mode === "ended" && endedBadge) {
      setEndedBadgeShown(true);
      const timer = setTimeout(() => { setEndedBadgeShown(false); }, 3000);
      return () => { clearTimeout(timer); };
    }
    setEndedBadgeShown(false);
    return undefined;
  }, [mode, endedBadge]);

  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.bdr}`,
        borderRadius: 12,
        padding: "12px 8px 8px 4px",
        ...(fill ? { height: "100%", display: "flex", flexDirection: "column" } : {}),
      }}
    >
      {/* Header: mode badge only (no legend in Variante C) */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          paddingLeft: 12,
          paddingRight: 12,
          marginBottom: 8,
          minHeight: 18,
        }}
      >
        {/* LIVE badge — only during brewing */}
        {mode === "brewing" && (
          <div
            style={{
              fontSize: 9.5,
              color: C.acc,
              background: C.accG,
              border: `1px solid ${C.accB}`,
              padding: "3px 9px",
              borderRadius: 11,
              fontWeight: 700,
              letterSpacing: "0.06em",
              display: "flex",
              alignItems: "center",
              gap: 5,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                background: C.acc,
                animation: "xenia-pulse 1.4s ease-in-out infinite",
              }}
            />
            LIVE
          </div>
        )}

        {/* "Bezug beendet" badge — shown 3s after a shot ends (not in static views) */}
        {mode === "ended" && endedBadge && endedBadgeShown && (
          <div
            style={{
              fontSize: 10,
              color: C.grn,
              background: C.grnD,
              border: `1px solid ${C.grn}30`,
              padding: "3px 10px",
              borderRadius: 9,
              fontWeight: 700,
              letterSpacing: "0.06em",
              flexShrink: 0,
            }}
          >
            BEZUG BEENDET
          </div>
        )}
      </div>

      {/* Chart — fills the card (flex) when `fill`, else fixed px height */}
      <div style={fill ? { flex: 1, minHeight: 0 } : undefined}>
      <ResponsiveContainer width="100%" height={fill ? "100%" : chartHeight}>
        {/* Stage overlay writes its marker labels above the plot — make room. */}
        <ComposedChart data={chartData} margin={{ top: stageOverlay ? 16 : 4, right: showTempAxis ? RIGHT_MARGIN_TEMP : RIGHT_MARGIN_PLAIN, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="shotPressureFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COLOR.pressure} stopOpacity={0.12} />
              <stop offset="100%" stopColor={COLOR.pressure} stopOpacity={0} />
            </linearGradient>
          </defs>

          <CartesianGrid strokeDasharray="3 3" stroke={C.bdr} vertical={false} />

          {/* X axis — elapsed seconds.
              allowDataOverflow={true} is required: without it Recharts auto-expands
              the domain leftward to include all data points, keeping xMin=0 and
              preventing the sliding window from moving. */}
          <XAxis
            dataKey="t"
            type="number"
            domain={[xDomain.min, xDomain.max]}
            allowDataOverflow={true}
            {...(grow
              ? { ticks: fixedXTicks(xDomain.max), interval: 0 }
              : { tickCount: 7 })}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: C.bdr }}
            tickFormatter={(v: number) => `${v}s`}
          />

          {/* Y-left — pressure scale 0-12 (proportional reference for all left-axis lines).
              allowDataOverflow prevents Recharts from auto-expanding the domain if scaled
              weight values temporarily exceed 12 (shouldn't happen but safeguard). */}
          <YAxis
            yAxisId="main"
            orientation="left"
            domain={[0, Y_LEFT_MAX]}
            allowDataOverflow={true}
            tickCount={7}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={Y_LEFT_WIDTH}
            label={{
              value: "bar",
              angle: -90,
              position: "insideLeft",
              offset: 10,
              style: { fill: C.dim, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" },
            }}
          />

          {/* Y-right — temperature 60-100°C */}
          {showTempAxis && (
            <YAxis
              yAxisId="temp"
              orientation="right"
              domain={[60, 100]}
              tickCount={5}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={Y_RIGHT_WIDTH}
              label={{
                value: "°C",
                angle: 90,
                position: "insideRight",
                offset: 12,
                style: { fill: C.dim, fontSize: 9, fontFamily: "'JetBrains Mono', monospace" },
              }}
            />
          )}

          {/* Custom tooltip — nur außerhalb des Brühens. Während eines Live-Bezugs
              poppt er auf Touch auf und bleibt hängen; Live-Werte stehen in den Tiles. */}
          {mode !== "brewing" && (
            <Tooltip
              content={<CustomTooltip yWeightMax={yWeightMax} />}
              cursor={{ stroke: C.bdrL, strokeWidth: 1 }}
            />
          )}

          {/* Pre-infusion band + transition marker (History detail). Behind the
              data lines; shades [0, t] and marks where extraction begins. */}
          {preinfusionEndS !== null && preinfusionEndS > 0 && (
            <>
              <ReferenceArea
                yAxisId="main"
                x1={0}
                x2={preinfusionEndS}
                fill={BAND_PREINFUSION}
                stroke="none"
              />
              <ReferenceArea
                yAxisId="main"
                x1={preinfusionEndS}
                fill={BAND_EXTRACTION}
                stroke="none"
              />
              {/* Without the stage overlay nothing else names the boundary. */}
              {!stageOverlay && (
                <ReferenceLine
                  yAxisId="main"
                  x={preinfusionEndS}
                  stroke={C.bdr3}
                  strokeDasharray="2 3"
                  label={{ value: "Extraktion", position: "insideTopLeft", fill: C.mut, fontSize: 8.5 }}
                />
              )}
            </>
          )}

          {/* Yield-target reference line (dashed, accent) */}
          {targetY !== null && (
            <ReferenceLine
              yAxisId="main"
              y={targetY}
              stroke={C.acc}
              strokeOpacity={0.55}
              strokeDasharray="6 4"
              strokeWidth={1.5}
            />
          )}

          {/* Ghosts of past shots — first, so every measured line sits on top. */}
          {ghosts && mode !== "brewing" && (
            <Customized
              component={
                <ShotGhostLayer
                  ghosts={ghosts}
                  pressureColor={COLOR.pressure}
                  flowColor={COLOR.flow}
                />
              }
            />
          )}

          {/* Pressure area fill (gradient behind line) */}
          <Area
            yAxisId="main"
            dataKey="pressure"
            stroke="none"
            fill="url(#shotPressureFill)"
            isAnimationActive={false}
            dot={false}
            connectNulls={bridgeOverlayGaps}
          />

          {/* Pressure line */}
          <Line
            yAxisId="main"
            dataKey="pressure"
            name="pressure"
            stroke={COLOR.pressure}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            connectNulls={bridgeOverlayGaps}
          />

          {/* Flow line */}
          <Line
            yAxisId="main"
            dataKey="flow"
            name="flow"
            stroke={COLOR.flow}
            strokeWidth={1.6}
            dot={false}
            isAnimationActive={false}
            connectNulls={bridgeOverlayGaps}
          />

          {/* Temp line */}
          <Line
            yAxisId={showTempAxis ? "temp" : "main"}
            dataKey="temp"
            name="temp"
            stroke={COLOR.temp}
            strokeWidth={1.3}
            dot={false}
            isAnimationActive={false}
            connectNulls={bridgeOverlayGaps}
          />

          {/* Weight line (pre-scaled to main axis) */}
          <Line
            yAxisId="main"
            dataKey="weight"
            name="weight"
            stroke={COLOR.weight}
            strokeWidth={1.6}
            strokeDasharray="4 2"
            dot={false}
            isAnimationActive={false}
            connectNulls={bridgeOverlayGaps}
          />

          {/* Measured pump-power curve (%, scaled to main axis) — toggleable. */}
          {showPump && (
            <Line
              yAxisId="main"
              dataKey="pump"
              name="pump"
              stroke={C.seriesPower}
              strokeWidth={1.3}
              strokeOpacity={0.85}
              dot={false}
              isAnimationActive={false}
              connectNulls={bridgeOverlayGaps}
            />
          )}

          {/* SO-1: commanded Soll overlay — dashed; solid part normal, held part faded. */}
          {overlay && (
            <>
              {overlay.markers.map((m, i) => (
                <ReferenceLine
                  key={`soll-mark-${i}`}
                  yAxisId="main"
                  x={m.t}
                  stroke={C.bdr3}
                  strokeDasharray="2 3"
                  label={{ value: m.label, position: "insideTopRight", fill: C.mut, fontSize: 8.5 }}
                />
              ))}
              <Line yAxisId="main" dataKey="sollBar" stroke={SOLL_GREEN} strokeWidth={1.8} strokeDasharray="5 3" dot={false} isAnimationActive={false} connectNulls />
              <Line yAxisId="main" dataKey="sollBarHeld" stroke={SOLL_GREEN} strokeOpacity={0.35} strokeWidth={1.5} strokeDasharray="2 4" dot={false} isAnimationActive={false} connectNulls />
              <Line yAxisId="main" dataKey="sollFlow" stroke={SOLL_GREEN} strokeWidth={1.6} strokeDasharray="5 3" dot={false} isAnimationActive={false} connectNulls />
              <Line yAxisId="main" dataKey="sollFlowHeld" stroke={SOLL_GREEN} strokeOpacity={0.35} strokeWidth={1.4} strokeDasharray="2 4" dot={false} isAnimationActive={false} connectNulls />
            </>
          )}

          {/* Flow-Hold stages: green Soll flow staircase (of the stages that ran),
              faint ghost refs for planned-but-never-run flows, vertical markers. */}
          {stageOverlay && (
            <>
              {stageOverlay.markers.map((m, i) => (
                <ReferenceLine
                  key={`stage-mark-${i}`}
                  yAxisId="main"
                  x={m.t}
                  stroke={STAGE_GREEN}
                  strokeOpacity={0.55}
                  strokeDasharray="3 3"
                  label={{ value: m.label, position: "top", fill: STAGE_GREEN, fontSize: 9, opacity: 0.9 }}
                />
              ))}
              {stageOverlay.masterStop && (
                <ReferenceLine
                  yAxisId="main"
                  x={stageOverlay.masterStop.t}
                  stroke={SOLL_GREEN}
                  strokeOpacity={0.8}
                  strokeWidth={1.5}
                  label={{ value: stageOverlay.masterStop.label, position: "top", fill: SOLL_GREEN, fontSize: 9, fontWeight: 600 }}
                />
              )}
              <Line yAxisId="main" dataKey="stageGhostSoll" name="stageGhostSoll" stroke={SOLL_GREEN} strokeOpacity={0.32} strokeWidth={1.5} strokeDasharray="2 5" dot={false} isAnimationActive={false} connectNulls />
              <Line yAxisId="main" dataKey="stageFlowSoll" name="stageFlowSoll" stroke={SOLL_GREEN} strokeOpacity={0.85} strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} connectNulls />
            </>
          )}
        </ComposedChart>
      </ResponsiveContainer>
      </div>
      {stageStrip && (
        // Linker Rand = Breite der linken Y-Achse (Diagrammrand links ist 0),
        // rechter Rand = Rand rechts + Breite der Temperaturachse.
        <StageStrip
          strip={stageStrip.strip}
          firstDropS={stageStrip.firstDropS}
          xMin={xDomain.min}
          xMax={xDomain.max}
          padLeft={Y_LEFT_WIDTH}
          padRight={showTempAxis ? RIGHT_MARGIN_TEMP + Y_RIGHT_WIDTH : RIGHT_MARGIN_PLAIN}
        />
      )}
    </div>
  );
}

export const ShotChart = memo(ShotChartInner, (prev, next) =>
  prev.samples                === next.samples &&
  prev.mode                   === next.mode &&
  prev.yieldTarget            === next.yieldTarget &&
  prev.yWeightMax             === next.yWeightMax &&
  prev.showTempAxis           === next.showTempAxis &&
  prev.xSettings              === next.xSettings &&
  prev.chartHeight            === next.chartHeight &&
  prev.fill                   === next.fill &&
  prev.endedBadge             === next.endedBadge &&
  prev.overlay                === next.overlay &&
  prev.stageOverlay           === next.stageOverlay &&
  prev.preinfusionEndS        === next.preinfusionEndS &&
  prev.showPump               === next.showPump &&
  prev.ghosts                 === next.ghosts &&
  prev.stageStrip             === next.stageStrip,
);
