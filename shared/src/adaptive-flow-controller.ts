/**
 * Adaptive plant-inversion flow controller (Phase B).
 *
 * Flavio's rule: "flow rises fast → low resistance → drop power aggressively;
 * flow sluggish → raise". This controller learns the puck conductance online
 * (Ĉ = ema(flow/power)), inverts the gray-box plant flow = C·power as a
 * feedforward power = setpoint/Ĉ, and adds a light PI trim on the residual
 * error. It keeps the same asymmetric slew limit as the fixed PI (tight-up /
 * loose-down = anti-gush). During fill (flow≈0) Ĉ is frozen, so the feedforward
 * holds the seed power instead of winding up.
 *
 * Validated in sim (scripts/ab-sim.ts) to generalize across a fresh and a spent
 * puck better than the fixed PI. No I/O, no clock (dt passed in) → unit-testable.
 *
 * See plant-sim.ts / ab-sim.ts for the gray-box rationale and limits.
 */

import type { FlowController, FlowControllerStep } from "./flow-controller.js";

export interface AdaptiveControllerConfig {
  /** Target process value (flow, g/s). */
  setpoint: number;
  /** Output floor (%) — dead-zone / minimum pump power that still pumps. */
  outMin: number;
  /** Output ceiling (%). */
  outMax: number;
  /** EMA smoothing factor for the flow measurement (0..1). */
  emaAlpha: number;
  /** Conductance-estimate EMA factor (0..1). Higher = tracks the plant faster. */
  betaC: number;
  /** Conductance floor (g/s per %) to keep the feedforward finite. */
  cMin: number;
  /** Proportional trim gain on the residual error. */
  kpTrim: number;
  /** Integral trim gain on the residual error. */
  kiTrim: number;
  /** Derivative gain on the *measurement* (not the error): brakes power when the
   *  flow is rising and adds when it is falling (u -= kd·dFlow/dt). Damps the
   *  overshoot/limit-cycle at setpoint-down transitions on a laggy, compliant
   *  puck. Derivative-on-measurement (not error) → a setSetpoint step gives no
   *  derivative kick. Omitted/0 = pure PI trim (unchanged). */
  kdTrim?: number;
  /** Asymmetric output slew (pump-% per second): raise vs lower. */
  slewUpPerS?: number;
  slewDownPerS?: number;
  /** Only learn Ĉ once real flow is present (g/s). */
  minFlowForEst: number;
  /** ...and only while the power is above the floor by this margin (%). */
  estPowerMargin: number;
  /** Ĉ aus dem Fluss und der Leistung von VOR dieser Zeit lernen (ms). Der
   *  Tassenfluss zeigt die Leistung von vor ~1–1,5 s (Puck → Tasse → Waage);
   *  mit der aktuellen Leistung geteilt haelt der Regler den Puck auf einer
   *  Flussspitze fuer viel durchlaessiger als er ist und regelt zu tief
   *  (#256: Schaetzung −24 … +37 %, zeitversetzt −15 … +18 %).
   *  Omitted/0 = aktuelle Leistung (unveraendert). */
  learnDelayMs?: number;
}

export interface AdaptiveStep extends FlowControllerStep {
  /** Current online conductance estimate (g/s per %). */
  cHat: number;
  /** Feedforward power from the plant inversion (%). */
  ff: number;
  /** setpoint − smoothed flow (g/s). */
  error: number;
  /** EMA-smoothed flow fed into the loop (g/s). */
  flow: number;
  /** Rate of change of the smoothed flow (g/s per s) that feeds the D-term. */
  dFlowDt: number;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export class AdaptiveController implements FlowController {
  private setpoint: number;
  private cHat = 0.03;
  private integral = 0;
  private ema: number | null = null;
  private lastFlow: number | null = null;
  private lastOutput: number;
  /** Kam beim letzten Schritt schon Fluss an (ueber minFlowForEst)? */
  private flowing = false;
  /** Leistungsverlauf fuer das zeitversetzte Lernen (learnDelayMs). */
  private clockS = 0;
  private outputHistory: { t: number; out: number }[] = [];

  constructor(private readonly cfg: AdaptiveControllerConfig) {
    if (cfg.outMin > cfg.outMax) {
      throw new Error(`AdaptiveController: outMin (${cfg.outMin}) > outMax (${cfg.outMax})`);
    }
    this.setpoint = cfg.setpoint;
    this.lastOutput = cfg.outMin;
  }

  /** Retarget the flow setpoint mid-shot (staged profiles). Ĉ and the integral
   *  are preserved; only the feedforward target changes → bumpless. */
  setSetpoint(setpoint: number): void {
    this.setpoint = setpoint;
  }

  /** Bumpless seed: pick Ĉ so the feedforward equals the seed power at t=0. */
  seed(output: number): void {
    const p = clamp(output, this.cfg.outMin, this.cfg.outMax);
    this.lastOutput = p;
    this.cHat = this.setpoint / Math.max(p, 1);
    this.ema = null;
    this.lastFlow = null;
    this.integral = 0;
    this.flowing = false;
  }

  /** Die zuletzt ausgegebene Leistung, die mindestens `delayS` alt ist. Reicht
   *  der Verlauf noch nicht so weit zurueck (Start), die aelteste bekannte —
   *  ohne Verlauf die aktuelle. Der Verlauf ueberlebt seed(): die Pumpe ist
   *  dieselbe, ein Stufenwechsel aendert nicht, was vor 1,5 s lief. */
  private outputBefore(delayS: number): number {
    if (delayS <= 0 || this.outputHistory.length === 0) return this.lastOutput;
    const cutoff = this.clockS - delayS;
    let out = this.outputHistory[0].out;
    for (const h of this.outputHistory) {
      if (h.t <= cutoff) out = h.out;
      else break;
    }
    return out;
  }

  update(measured: number, dtMs: number): AdaptiveStep {
    const dtS = Math.max(0, dtMs) / 1000;
    this.clockS += dtS;
    this.ema =
      this.ema === null
        ? measured
        : this.cfg.emaAlpha * measured + (1 - this.cfg.emaAlpha) * this.ema;
    const flow = this.ema;

    // Durchbruch nach einer Phase ohne Fluss (Auffuellen nach dem Bloom, erster
    // Tropfen): der Integralanteil hat beim Warten Leistung angesammelt — das
    // war noetig, um die Pumpe ueber ihre Anlaufschwelle zu bringen. Ab jetzt
    // waere es ein bleibender Ueberschuss (#251: 3,1 statt 2,5 g/s, weil sich
    // ~9,6 % nicht mehr abbauten). Deshalb uebergangslos in die Leitfaehigkeits-
    // Schaetzung uebernehmen (die Vorsteuerung liefert dieselbe Leistung) und
    // den Integralspeicher leeren; das Lernen fuehrt Ĉ danach zur echten Strecke.
    const nowFlowing = flow > this.cfg.minFlowForEst;
    if (nowFlowing && !this.flowing && this.setpoint > 0) {
      const ffNow = this.setpoint / Math.max(this.cHat, this.cfg.cMin);
      this.cHat = this.setpoint / Math.max(ffNow + this.cfg.kiTrim * this.integral, 1);
      this.integral = 0;
    }
    this.flowing = nowFlowing;

    // Learn conductance only when observable (real flow + above the floor).
    // An der Untergrenze nur nach unten: liefert die Pumpe dort weniger als den
    // Sollwert, ist Ĉ nachweislich zu hoch — die Vorsteuerung laege unter der
    // Untergrenze, und ohne Nachlernen hinge die Pumpe in ihrer Totzone fest
    // (#246: 15 s bei 15 % mit 0,2–0,5 statt 0,7 g/s nach einem Schwall). Nach
    // oben lernt sie dort nicht: in der Totzone unterschaetzt Fluss/Leistung die
    // Strecke, ein hoeheres Ĉ waere dort nie belegt.
    if (flow > this.cfg.minFlowForEst) {
      const learnOut = this.outputBefore((this.cfg.learnDelayMs ?? 0) / 1000);
      const cObs = flow / learnOut;
      const aboveFloor = learnOut > this.cfg.outMin + this.cfg.estPowerMargin;
      if (aboveFloor || (cObs < this.cHat && flow < this.setpoint)) {
        this.cHat = this.cfg.betaC * cObs + (1 - this.cfg.betaC) * this.cHat;
      }
    }

    const ff = this.setpoint / Math.max(this.cHat, this.cfg.cMin); // plant inversion
    const error = this.setpoint - flow;
    const candIntegral = this.integral + error * dtS;
    // Derivative on the measurement (0 on the very first sample). Braking a fast
    // flow rise here is what damps the setpoint-down limit cycle.
    const dFlowDt = this.lastFlow === null || dtS <= 0 ? 0 : (flow - this.lastFlow) / dtS;
    const unclamped =
      ff + this.cfg.kpTrim * error + this.cfg.kiTrim * candIntegral - (this.cfg.kdTrim ?? 0) * dFlowDt;

    let output = clamp(unclamped, this.cfg.outMin, this.cfg.outMax);
    if (dtS > 0) {
      if (this.cfg.slewUpPerS !== undefined) {
        output = Math.min(output, this.lastOutput + this.cfg.slewUpPerS * dtS);
      }
      if (this.cfg.slewDownPerS !== undefined) {
        output = Math.max(output, this.lastOutput - this.cfg.slewDownPerS * dtS);
      }
      output = clamp(output, this.cfg.outMin, this.cfg.outMax);
    }

    // Anti-windup: commit the trim integral unless the output is limited AND the
    // error would drive it even deeper past that limit.
    const limited = output !== unclamped;
    if (!limited) {
      this.integral = candIntegral;
    } else {
      const pushingIntoRail =
        (output < unclamped && error > 0) || (output > unclamped && error < 0);
      if (!pushingIntoRail) this.integral = candIntegral;
    }

    this.lastOutput = output;
    this.lastFlow = flow;
    const delayS = (this.cfg.learnDelayMs ?? 0) / 1000;
    if (delayS > 0) {
      this.outputHistory.push({ t: this.clockS, out: output });
      while (this.outputHistory.length > 1 && this.outputHistory[1].t <= this.clockS - delayS) {
        this.outputHistory.shift();
      }
    }
    return { output, cHat: this.cHat, ff, error, flow, dFlowDt };
  }
}
