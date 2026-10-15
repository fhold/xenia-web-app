/**
 * buildScriptOverlay — pure transform (SO-1) that turns a resolved script body
 * + the actual brew duration into a commanded "Soll" overlay for the History
 * detail ShotChart (commanded vs. measured).
 *
 * Alignment (decided fork): the Soll curve is placed on the REAL time axis from
 * t=0. In the deterministic start (only Cmd-12 waits) nominal time == real time,
 * so Soll lines up 1:1 with the measured curve. From the FIRST indeterminate
 * wait (Cmd 27 "bis g" / Cmd 25 "bis °C") OR the real stop (whichever is
 * earlier), alignment is no longer knowable → the Soll is drawn "held" (the last
 * value, flat) and the frontend renders it damped, with markers for the
 * determinism end and the stop.
 *
 * Pressure (Cmd 4) and power (Cmd 3, via powerToBar in scriptToTimeline) share
 * the bar series; flow (Cmd 5) is the ml/s series. Never throws — unresolvable /
 * empty input returns null (→ no overlay).
 */

import { parseScript } from "./script-parser.js";
import { scriptToTimeline } from "./script-timeline.js";

export interface OverlayPoint {
  /** Real time in ms (nominal == real in the deterministic region). */
  t: number;
  /** Value in the series' axis unit: bar for `bar`, ml/s for `flow`. */
  v: number;
}

export interface ScriptOverlay {
  /** Bar series (pressure + power-as-bar): solid part, then the held/damped part. */
  barSolid: OverlayPoint[];
  barHeld: OverlayPoint[];
  /** Flow series (ml/s): solid + held. Empty when the script has no flow command. */
  flowSolid: OverlayPoint[];
  flowHeld: OverlayPoint[];
  /** Nominal time (ms) of the first indeterminate wait, or null if none. */
  determinismEndMs: number | null;
  /** Real brew duration (ms) — ended_at − started_at (or last sample). */
  stopMs: number;
  /** Soll is full up to here = min(determinismEnd ?? ∞, stop); damped after. */
  solidUntilMs: number;
  /** Total nominal length of the commanded script (ms). */
  totalMs: number;
  /** UP-10: where the Soll curve is clipped = min(totalMs, stopMs). */
  clipEndMs: number;
}

function valueAt(pts: OverlayPoint[], t: number): number | null {
  if (pts.length === 0) return null;
  if (t <= pts[0].t) return pts[0].v;
  const last = pts[pts.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t >= t) {
      const a = pts[i - 1];
      const b = pts[i];
      const span = b.t - a.t;
      const f = span === 0 ? 0 : (t - a.t) / span;
      return a.v + (b.v - a.v) * f;
    }
  }
  return last.v;
}

/** Split a full point series at `solidUntil` into a solid part + a held (flat,
 *  last-value) part running to `clipEnd` (UP-10: never beyond the brew end). */
function split(
  pts: OverlayPoint[],
  solidUntil: number,
  clipEnd: number,
): { solid: OverlayPoint[]; held: OverlayPoint[] } {
  if (pts.length === 0) return { solid: [], held: [] };
  const vAt = valueAt(pts, solidUntil);
  const solid = pts.filter((p) => p.t < solidUntil);
  if (vAt !== null) solid.push({ t: solidUntil, v: vAt });
  const held =
    vAt !== null && solidUntil < clipEnd
      ? [{ t: solidUntil, v: vAt }, { t: clipEnd, v: vAt }]
      : [];
  return { solid, held };
}

export function buildScriptOverlay(
  content: string | null | undefined,
  actualDurationMs: number,
): ScriptOverlay | null {
  if (!content || typeof content !== "string") return null;
  const tl = scriptToTimeline(parseScript(content));
  if (tl.phases.length === 0 && tl.waits.length === 0) return null;

  // Full Soll points per series, from the effective (non-noWait) phases.
  const barFull: OverlayPoint[] = [];
  const flowFull: OverlayPoint[] = [];
  for (const ph of tl.phases) {
    if (ph.noWait) continue;
    const sink = ph.axis === "flow" ? flowFull : barFull;
    sink.push({ t: ph.tStart, v: ph.startValue });
    if (!ph.truncated && ph.rampDurMs > 0 && ph.rampEndT > ph.tStart) {
      sink.push({ t: ph.rampEndT, v: ph.targetValue });
      if (ph.tEnd > ph.rampEndT) sink.push({ t: ph.tEnd, v: ph.targetValue });
    } else {
      sink.push({ t: ph.tEnd, v: ph.endValue });
    }
  }

  const determinismEndMs = tl.waits.length > 0 ? tl.waits[0].tStart : null;
  const stopMs = Math.max(0, actualDurationMs);
  const solidUntilMs = Math.min(determinismEndMs ?? Infinity, stopMs);
  const totalMs = tl.totalMs;
  // UP-10: the Soll curve is clipped to the actual brew end — never drawn past
  // the stop (held part ends at min(script end, brew end)).
  const clipEndMs = Math.min(totalMs, stopMs);

  const bar = split(barFull, solidUntilMs, clipEndMs);
  const flow = split(flowFull, solidUntilMs, clipEndMs);

  return {
    barSolid: bar.solid,
    barHeld: bar.held,
    flowSolid: flow.solid,
    flowHeld: flow.held,
    determinismEndMs,
    stopMs,
    solidUntilMs,
    totalMs,
    clipEndMs,
  };
}
