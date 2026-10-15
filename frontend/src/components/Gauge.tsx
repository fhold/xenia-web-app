/**
 * Gauge chip — Variante C "Instrument" (Handoff 5.8.1).
 *
 * Layout: [3px colored bar] [label 9.5px uppercase] over [Ist 16px Mono
 * + " / Soll°" small]. Each gauge is a self-contained bordered chip; the
 * three chips sit in a flex row in the dashboard header.
 *
 * Temperature color logic (Handoff 5.7):
 *   Brew group / Brew boiler (steam=false):
 *     Red    (#F87171): > 2°C above target  (too hot / overshoot)
 *     Green  (#4ADE80): -0.5 … +2°C         (at temp / ready)
 *     Orange (#FBBF24): -5 … -0.5°C         (almost there)
 *     Blue   (#60A5FA): < -5°C              (heating up)
 *   Steam boiler (steam=true):
 *     Red    (#F87171): ≤ 2°C below target  (hot / ready)
 *     Orange (#FBBF24): 2–15°C below target (warming up)
 *     Blue   (#60A5FA): > 15°C below target (cold)
 *   No target provided → accent color (#7B9FCC), no threshold logic.
 */

interface GaugeProps {
  label: string;
  value: number;
  unit: string;
  /** When provided, enables threshold-based color logic (Handoff 5.7). */
  target?: number;
  /**
   * Setpoint to display as a small "SOLL: …" line above the measured value.
   * Independent of `target`: `target` drives color (and may be gated by
   * machine state), `setpoint` is display-only and shown whenever provided —
   * so it stays visible even when the machine is off or in ECO.
   */
  setpoint?: number;
  /** Decimal places for the displayed setpoint. Default: 0 (whole number). */
  setpointDecimals?: number;
  /** Use steam boiler color thresholds instead of brew group thresholds. */
  steam?: boolean;
  /** Decimal places for the displayed value. Default: 1. */
  decimals?: number;
  /** Tap handler — shows pencil icon when set. */
  onTap?: () => void;
  /** Mobile: stretch to share the row width (flex) so the gauge row reaches the
   *  right edge, flush with the favorite pills below. Desktop: natural width. */
  mobile?: boolean;
}

import theme from '../theme';
const C = theme;

/**
 * 4-step temperature color logic (Handoff §5.7). Exported so the Pre-Shot
 * profile-temp readiness ampel (PT-2) reuses the exact same thresholds.
 */
export function resolveColor(
  value: number,
  target: number | undefined,
  steam: boolean | undefined,
): string {
  if (target === undefined) return C.acc;

  const diff = value - target; // positive = above target, negative = below

  if (steam) {
    if (diff >= -2) return C.red;   // ≤ 2°C under → hot/ready
    if (diff >= -15) return C.org;  // 2–15°C under → warming
    return C.blu;                   // > 15°C under → cold
  } else {
    if (diff > 2)    return C.red;  // too hot / overshoot
    if (diff >= -0.5) return C.grn; // at temp
    if (diff >= -5)   return C.org; // almost there
    return C.blu;                   // heating up
  }
}

export function Gauge({
  label,
  value,
  unit,
  target,
  setpoint,
  setpointDecimals = 0,
  steam,
  decimals = 1,
  onTap,
  mobile = false,
}: GaugeProps) {
  const color = resolveColor(value, target, steam);
  // Temperature chips show "°" after the setpoint; pressure (bar) shows no unit
  // — the chip stays compact and the label already identifies the reading.
  const sollSuffix = unit.startsWith("°") ? "°" : "";

  return (
    <div
      onClick={onTap}
      style={{
        minWidth: 0,
        flex: mobile ? "1 1 0" : undefined,
        background: C.card,
        border: `1px solid ${C.bdr}`,
        borderRadius: 9,
        padding: "8px 12px",
        cursor: onTap ? "pointer" : "default",
      }}
    >
      {/* Label — 9.5px uppercase */}
      <div
        style={{
          fontSize: 9.5,
          color: C.mut,
          textTransform: "uppercase",
          letterSpacing: "1.2px",
          lineHeight: 1.1,
        }}
      >
        {label}
      </div>

      {/* Ist value (status-coloured) + inline " / Soll". No left stripe —
          the colour lives in the value itself, distinct from the readout
          overlay (striped + neutral value). */}
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 16,
          color,
          lineHeight: 1,
          marginTop: 3,
          whiteSpace: "nowrap",
        }}
      >
        {value.toFixed(decimals)}
        {setpoint !== undefined && (
          <small style={{ fontSize: 13, color: C.mut }}>
            {" "}
            / {setpoint.toFixed(setpointDecimals)}
            {sollSuffix}
          </small>
        )}
      </div>
    </div>
  );
}
