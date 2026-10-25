/**
 * Pure PI controller for the flow-hold espresso drive (Phase 1).
 *
 * Regulates a single actuator (pump power, %) against a measured process value
 * (scale-derived flow, g/s) toward a setpoint. Direct-acting: a positive error
 * (measured below setpoint) raises the output.
 *
 * Design notes:
 *   - Positional form: output = kp·error + ki·integral, clamped to [outMin,outMax].
 *     The integral carries the steady-state operating point (the pump power that
 *     holds the target flow), so no separate feed-forward bias is needed.
 *   - Anti-windup by conditional integration: while the output is saturated, the
 *     integral is frozen if further accumulation would push deeper into the rail,
 *     and released as soon as the error reverses. This prevents the integral from
 *     winding up during the ramp / dead-zone and overshooting on hand-off.
 *   - EMA smoothing of the (noisy) flow measurement before the error is formed.
 *   - seed(): bumpless transfer from the open-loop ramp — sets the integral so
 *     that at zero error the output equals the ramp hand-off power.
 *
 * No I/O, no clock (dt is passed in) → unit-testable in isolation.
 */

import type { FlowController } from "./flow-controller.js";

export interface PIControllerConfig {
  /** Proportional gain (output-% per unit of flow error, g/s). */
  kp: number;
  /** Integral gain (output-% per unit of accumulated flow error, g/s·s). */
  ki: number;
  /** Target process value (flow, g/s). */
  setpoint: number;
  /** Output floor (%). For flow-hold this is the dead-zone / power-floor bound. */
  outMin: number;
  /** Output ceiling (%). */
  outMax: number;
  /** EMA smoothing factor for the measurement, 0..1. 1 = no smoothing (raw),
   *  lower = heavier smoothing. */
  emaAlpha: number;
  /**
   * Asymmetric output slew limit (output-% per second). Caps how fast the
   * commanded output may change between steps: `slewUpPerS` when raising power,
   * `slewDownPerS` when lowering it. A soft (spent) puck gushes when power is
   * pushed up too fast, so the intended tuning is tight-up / loose-down
   * (anti-gush). Omit either to leave that direction unlimited. */
  slewUpPerS?: number;
  slewDownPerS?: number;
}

export interface PIStep {
  /** Clamped controller output (%) — the value to command the pump with. */
  output: number;
  /** setpoint − smoothedInput (g/s). Positive = flow too low → raise power. */
  error: number;
  /** Proportional term (kp·error). */
  pTerm: number;
  /** Integral term (ki·integral) after this step's anti-windup decision. */
  iTerm: number;
  /** Current integral accumulator (pre-gain). */
  integral: number;
  /** EMA-smoothed measurement fed into the error. */
  smoothedInput: number;
  /** True if the raw (unclamped) output hit a rail this step. */
  saturated: boolean;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export class PIController implements FlowController {
  private integral = 0;
  private ema: number | null = null;
  /** Last commanded output, for the slew limiter. null = no reference yet. */
  private lastOutput: number | null = null;

  constructor(private readonly cfg: PIControllerConfig) {
    if (cfg.outMin > cfg.outMax) {
      throw new Error(`PIController: outMin (${cfg.outMin}) > outMax (${cfg.outMax})`);
    }
  }

  /** Retarget the setpoint mid-shot (staged profiles). The integral carries the
   *  operating point, so the transfer is effectively bumpless — no reset. */
  setSetpoint(setpoint: number): void {
    this.cfg.setpoint = setpoint;
  }

  /** Clear the integral and the smoothing state. */
  reset(): void {
    this.integral = 0;
    this.ema = null;
    this.lastOutput = null;
  }

  /**
   * Bumpless seed: set the integral so that, at zero error, the controller
   * output equals `output` (the open-loop ramp hand-off power). Also resets the
   * EMA so the first post-seed measurement is taken verbatim, and anchors the
   * slew limiter at the hand-off power.
   */
  seed(output: number): void {
    const clamped = clamp(output, this.cfg.outMin, this.cfg.outMax);
    this.integral = this.cfg.ki !== 0 ? clamped / this.cfg.ki : 0;
    this.ema = null;
    this.lastOutput = clamped;
  }

  /**
   * Arbeitspunkt verschieben (Vorsteuerung): der Ausgang bei Fehler null wandert um
   * `delta` (%). Sonst muesste der I-Anteil die Aenderung ueber einen bleibenden
   * Fehler nachholen — bei einer Rampe ist das der Nachlauf (Steigung / ki).
   * Begrenzt wie der Ausgang, damit nichts gegen den Anschlag aufzieht.
   */
  shift(delta: number): void {
    if (this.cfg.ki === 0) return;
    const operatingPoint = clamp(this.cfg.ki * this.integral + delta, this.cfg.outMin, this.cfg.outMax);
    this.integral = operatingPoint / this.cfg.ki;
  }

  /**
   * Advance the controller by one step.
   * @param measured raw process value (flow, g/s)
   * @param dtMs     elapsed time since the previous update (ms)
   */
  update(measured: number, dtMs: number): PIStep {
    const dtS = Math.max(0, dtMs) / 1000;

    this.ema =
      this.ema === null
        ? measured
        : this.cfg.emaAlpha * measured + (1 - this.cfg.emaAlpha) * this.ema;
    const smoothedInput = this.ema;

    const error = this.cfg.setpoint - smoothedInput;
    const pTerm = this.cfg.kp * error;

    const candidateIntegral = this.integral + error * dtS;
    const unclamped = pTerm + this.cfg.ki * candidateIntegral;

    // 1. Clamp to the output bounds (dead-zone floor / ceiling).
    let output = clamp(unclamped, this.cfg.outMin, this.cfg.outMax);
    const saturated = output !== unclamped;

    // 2. Asymmetric slew limit relative to the last commanded output. Tight-up /
    //    loose-down is the anti-gush tuning: cap how fast power may rise, allow
    //    it to fall fast when the flow overshoots.
    if (this.lastOutput !== null && dtS > 0) {
      if (this.cfg.slewUpPerS !== undefined) {
        output = Math.min(output, this.lastOutput + this.cfg.slewUpPerS * dtS);
      }
      if (this.cfg.slewDownPerS !== undefined) {
        output = Math.max(output, this.lastOutput - this.cfg.slewDownPerS * dtS);
      }
      output = clamp(output, this.cfg.outMin, this.cfg.outMax);
    }

    // `limited` = output constrained by either a bound or the slew rate. Used for
    // anti-windup so the integral does not wind up against the slew limiter.
    const limited = output !== unclamped;

    // Anti-windup: commit the integral unless the output is limited AND the
    // error would drive it even deeper past that limit.
    if (!limited) {
      this.integral = candidateIntegral;
    } else {
      const pushingIntoRail =
        (output < unclamped && error > 0) || (output > unclamped && error < 0);
      if (!pushingIntoRail) this.integral = candidateIntegral;
    }

    this.lastOutput = output;

    return {
      output,
      error,
      pTerm,
      iTerm: this.cfg.ki * this.integral,
      integral: this.integral,
      smoothedInput,
      saturated,
    };
  }
}
