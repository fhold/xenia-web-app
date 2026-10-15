/**
 * ScriptTimelineChart (SE-2b, curve refined) — commanded setpoint curve.
 *
 * Pressure (Cmd 4) and power (Cmd 3) share ONE continuous line on a real BAR
 * axis: power is converted to its pressure-equivalent via powerToBar() (assumed
 * saturating curve, 75 % ≈ 9 bar / 100 % ≈ 10 bar) so a pressure↔power switch is
 * continuous (e.g. "Declining" falls 9 bar → ~4.3 bar instead of a V). Ramps are
 * slopes, holds flat; mode is shown by colour + boundary + a per-segment label
 * with the REAL command ("9 bar" / "20 %"); a hover tooltip gives the exact
 * command, unit and time. Flow (Cmd 5) lives on its own ml/s axis. Limits
 * (Cmd 29/30) and target-temp (Cmd 25) are dezente references. NOT a measured
 * extraction — that stays the Dashboard ShotChart.
 */

import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  ReferenceArea,
  Tooltip,
} from "recharts";
import type { ScriptTimeline, PumpMode } from "@shared/script-timeline.js";
import theme from "../theme.js";

const C = theme;
const MONO = "'JetBrains Mono', monospace";

const MODE_COLOR: Record<PumpMode, string> = { pressure: C.seriesPressure, flow: C.seriesFlow, power: C.seriesPower };

interface Row {
  t: number;
  raw: number;
  unit: string;
  mode: PumpMode;
  [seriesKey: string]: number | string;
}

interface TipPayload { payload: Row; }
function CurveTooltip({ active, payload, labelFmt }: { active?: boolean; payload?: TipPayload[]; labelFmt: (ms: number) => string }) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload.find((p) => p.payload && p.payload.raw !== undefined)?.payload;
  if (!row) return null;
  const v = Number.isInteger(row.raw) ? String(row.raw) : row.raw.toFixed(1);
  return (
    <div style={{ background: C.cardElev, border: `1px solid ${C.bdrL}`, borderRadius: 8, padding: "6px 10px", fontSize: 11.5 }}>
      <div style={{ fontFamily: MONO, color: MODE_COLOR[row.mode], fontWeight: 700 }}>{v} {row.unit}</div>
      <div style={{ color: C.mut, fontSize: 10, marginTop: 2, fontFamily: MONO }}>{labelFmt(row.t)}</div>
    </div>
  );
}

export function ScriptTimelineChart({
  timeline,
  height = 280,
}: {
  timeline: ScriptTimeline;
  height?: number;
}) {
  const { phases } = timeline;
  const live = phases.filter((p) => !p.noWait);
  if (live.length === 0 && timeline.waits.length === 0) return null;

  const hasFlow = live.some((p) => p.axis === "flow");

  // Bar-axis range: real pressure/power values + pressure limit, headroom over 10.
  let barMax = 10;
  let flowMax = 6;
  for (const p of live) {
    const m = Math.max(p.startValue, p.targetValue, p.endValue);
    if (p.axis === "bar") barMax = Math.max(barMax, m);
    else flowMax = Math.max(flowMax, m);
  }
  if (timeline.pressureLimitBar !== null) barMax = Math.max(barMax, timeline.pressureLimitBar);
  if (timeline.flowLimitMlS !== null) flowMax = Math.max(flowMax, timeline.flowLimitMlS);
  barMax = Math.ceil(barMax + 1);
  flowMax = Math.ceil(flowMax + 1);

  // One row array; each phase contributes points under its own key s{i} so each
  // renders as its own coloured <Line> on its axis, with a gap (= mode boundary).
  const rows: Row[] = [];
  live.forEach((ph, idx) => {
    const i = phases.indexOf(ph);
    const key = `s${i}`;
    const pushPt = (t: number, val: number) =>
      rows.push({ t, raw: ph.rawTarget, unit: ph.unit, mode: ph.mode, [key]: val } as Row);
    pushPt(ph.tStart, ph.startValue);
    if (!ph.truncated && ph.rampDurMs > 0 && ph.rampEndT > ph.tStart) {
      pushPt(ph.rampEndT, ph.targetValue);
      if (ph.tEnd > ph.rampEndT) pushPt(ph.tEnd, ph.targetValue);
    } else {
      pushPt(ph.tEnd, ph.endValue);
    }
    void idx;
  });
  rows.sort((a, b) => a.t - b.t);

  const labelFmt = (ms: number) => `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} s`;
  const axisTick = { fill: C.mut, fontSize: 10, fontFamily: MONO };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 16, right: hasFlow ? 8 : 12, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.bdr} vertical={false} />

        {/* Mode-coloured bands + per-segment label (real command). */}
        {live.map((ph) => {
          const i = phases.indexOf(ph);
          return (
            <ReferenceArea
              key={`band-${i}`}
              yAxisId="bar"
              x1={ph.tStart}
              x2={ph.tEnd}
              y1={0}
              y2={barMax}
              fill={MODE_COLOR[ph.mode]}
              fillOpacity={0.06}
              stroke="none"
              label={{ value: ph.label, position: "insideTop", fill: MODE_COLOR[ph.mode], fontSize: 10, fontWeight: 600 }}
            />
          );
        })}

        {/* Indeterminate-wait bands (Cmd 27/25). */}
        {timeline.waits.map((w, i) => (
          <ReferenceArea
            key={`wait-${i}`}
            yAxisId="bar"
            x1={w.tStart}
            x2={w.tEnd}
            y1={0}
            y2={barMax}
            fill={C.acc}
            fillOpacity={0.09}
            stroke={C.bdr2}
            strokeOpacity={0.6}
            label={{ value: w.label, position: "insideBottom", fill: C.mut, fontSize: 9 }}
          />
        ))}

        {/* Mode-switch divider lines. */}
        {live.slice(1).map((ph) => {
          const i = phases.indexOf(ph);
          return <ReferenceLine key={`div-${i}`} yAxisId="bar" x={ph.tStart} stroke={C.bdr3} strokeDasharray="2 3" />;
        })}

        {/* noWait commands → marker (ramp got no time). */}
        {phases.filter((p) => p.noWait).map((ph, i) => (
          <ReferenceLine
            key={`nw-${i}`}
            yAxisId="bar"
            x={ph.tStart}
            stroke={C.org}
            strokeDasharray="1 2"
            label={{ value: "ohne Warten", position: "top", fill: C.org, fontSize: 8.5 }}
          />
        ))}

        {/* Pressure limit (Cmd 29) on the bar axis. */}
        {timeline.pressureLimitBar !== null && (
          <ReferenceLine
            yAxisId="bar"
            y={timeline.pressureLimitBar}
            stroke={MODE_COLOR.pressure}
            strokeDasharray="5 4"
            strokeOpacity={0.5}
            label={{ value: `Limit ${timeline.pressureLimitBar} bar`, position: "right", fill: MODE_COLOR.pressure, fontSize: 9 }}
          />
        )}

        {/* Target-temp markers (Cmd 25). */}
        {timeline.tempSetpoints.map((tp, i) => (
          <ReferenceLine
            key={`temp-${i}`}
            yAxisId="bar"
            x={tp.t}
            stroke={C.acc}
            strokeDasharray="3 3"
            label={{ value: `${tp.value} °C`, position: "insideTopRight", fill: C.acc, fontSize: 9 }}
          />
        ))}

        <XAxis
          dataKey="t"
          type="number"
          domain={[0, timeline.totalMs]}
          tick={axisTick}
          tickLine={false}
          axisLine={{ stroke: C.bdr }}
          tickFormatter={(ms: number) => `${Math.round(ms / 1000)}s`}
        />
        {/* Left axis: bar (pressure + power-as-bar). */}
        <YAxis
          yAxisId="bar"
          domain={[0, barMax]}
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          width={30}
          tickFormatter={(v: number) => `${v}`}
        />
        {/* Right axis: flow (ml/s), only when a flow command is present. */}
        {hasFlow && (
          <YAxis
            yAxisId="flow"
            orientation="right"
            domain={[0, flowMax]}
            tick={{ ...axisTick, fill: MODE_COLOR.flow }}
            tickLine={false}
            axisLine={false}
            width={30}
          />
        )}

        {timeline.flowLimitMlS !== null && hasFlow && (
          <ReferenceLine
            yAxisId="flow"
            y={timeline.flowLimitMlS}
            stroke={MODE_COLOR.flow}
            strokeDasharray="5 4"
            strokeOpacity={0.5}
            label={{ value: `Limit ${timeline.flowLimitMlS} ml/s`, position: "left", fill: MODE_COLOR.flow, fontSize: 9 }}
          />
        )}

        <Tooltip content={<CurveTooltip labelFmt={labelFmt} />} />

        {/* One coloured line per phase on its axis. */}
        {live.map((ph) => {
          const i = phases.indexOf(ph);
          return (
            <Line
              key={`line-${i}`}
              yAxisId={ph.axis === "flow" ? "flow" : "bar"}
              type="linear"
              dataKey={`s${i}`}
              stroke={MODE_COLOR[ph.mode]}
              strokeWidth={2.5}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          );
        })}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
