/**
 * Unit tests for the adaptive plant-inversion flow controller (Phase B).
 *
 * Runner: node:test (NOT vitest) — run with `node --import tsx --test`.
 * Pin the pure decision logic: bumpless seed, online conductance learning,
 * plant-inversion convergence, the asymmetric slew limit, the output floor, and
 * bumpless mid-shot setpoint retargeting.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AdaptiveController,
  type AdaptiveControllerConfig,
} from "../src/adaptive-flow-controller.js";

const CONFIG: AdaptiveControllerConfig = {
  setpoint: 2.0,
  outMin: 15,
  outMax: 100,
  emaAlpha: 1, // no smoothing → measurements pass verbatim for deterministic asserts
  betaC: 0.2,
  cMin: 0.004,
  kpTrim: 1.5,
  kiTrim: 0.4,
  slewUpPerS: 8,
  slewDownPerS: 40,
  minFlowForEst: 0.15,
  estPowerMargin: 2,
};

function make(over: Partial<AdaptiveControllerConfig> = {}): AdaptiveController {
  return new AdaptiveController({ ...CONFIG, ...over });
}

// ---------------------------------------------------------------------------
// Construction guard
// ---------------------------------------------------------------------------

test("constructor rejects outMin > outMax", () => {
  assert.throws(() => new AdaptiveController({ ...CONFIG, outMin: 100, outMax: 50 }), /outMin/);
});

// ---------------------------------------------------------------------------
// Bumpless seed
// ---------------------------------------------------------------------------

test("bumpless seed: at the setpoint the first output equals the seed power", () => {
  const c = make();
  c.seed(50);
  // flow == setpoint → error 0, feedforward = setpoint/Ĉ = seed power.
  const step = c.update(2.0, 1000);
  assert.ok(Math.abs(step.output - 50) < 1e-9, `expected ~50, got ${step.output}`);
  assert.ok(Math.abs(step.error) < 1e-9, `expected zero error, got ${step.error}`);
});

// ---------------------------------------------------------------------------
// Online conductance learning
// ---------------------------------------------------------------------------

test("conductance estimate rises when flow is high relative to power", () => {
  const c = make();
  c.seed(50); // Ĉ = 2.0/50 = 0.04
  // Flow 4.0 at 50% ⇒ observed C 0.08 > 0.04 ⇒ Ĉ must move up.
  const step = c.update(4.0, 1000);
  assert.ok(step.cHat > 0.04, `Ĉ should rise: ${step.cHat}`);
  // Higher Ĉ ⇒ smaller feedforward (plant inversion): drop power.
  assert.ok(step.ff < 50, `feedforward should drop below the seed: ${step.ff}`);
});

// ---------------------------------------------------------------------------
// Closed-loop convergence against a fixed gray-box plant
// ---------------------------------------------------------------------------

test("closed loop converges flow toward the setpoint", () => {
  const c = make();
  const C = 0.03; // fixed plant conductance (g/s per %)
  c.seed(45);
  let power = 45;
  let flow = C * power;
  for (let i = 0; i < 300; i++) {
    const step = c.update(flow, 200);
    power = step.output;
    flow = C * power;
  }
  assert.ok(Math.abs(flow - 2.0) < 0.05, `flow did not converge: ${flow}`);
});

// ---------------------------------------------------------------------------
// Asymmetric slew limit
// ---------------------------------------------------------------------------

test("slewDownPerS caps how fast the output may fall", () => {
  const c = make();
  c.seed(90);
  // A large flow overshoot wants a big power cut; slew-down caps it to 40%/s.
  const step = c.update(10.0, 1000);
  assert.equal(step.output, 50, `expected 90-40=50, got ${step.output}`);
});

// ---------------------------------------------------------------------------
// Output floor
// ---------------------------------------------------------------------------

test("output never falls below the floor", () => {
  const c = make();
  c.seed(20);
  const step = c.update(20.0, 1000); // huge overshoot → wants far below floor
  assert.equal(step.output, CONFIG.outMin, `expected floor ${CONFIG.outMin}, got ${step.output}`);
});

// ---------------------------------------------------------------------------
// Derivative-on-measurement brake (kdTrim) — damps the setpoint-down ring
// ---------------------------------------------------------------------------

// Slew relaxed so the assertion isolates the D-term, not the slew limiter.
// First update establishes lastFlow (derivative is 0 on the first sample);
// the second update carries the rising/falling measurement the D-term acts on.
function outputOnFlowChange(kd: number, secondFlow: number): number {
  const c = make({ kdTrim: kd, slewUpPerS: 100, slewDownPerS: 100 });
  c.seed(50);
  c.update(2.0, 1000); // at setpoint, primes lastFlow
  return c.update(secondFlow, 1000).output;
}

test("kdTrim lowers output when the flow is rising (overshoot brake)", () => {
  const withoutD = outputOnFlowChange(0, 2.5);
  const withD = outputOnFlowChange(10, 2.5);
  // dFlow/dt = (2.5-2.0)/1s = 0.5 ⇒ −kd·dFlow ≈ −5 vs the pure-PI output.
  assert.ok(withD < withoutD - 4, `D-term should cut power on a rising flow: ${withoutD} -> ${withD}`);
});

test("kdTrim raises output when the flow is falling", () => {
  const withoutD = outputOnFlowChange(0, 1.5);
  const withD = outputOnFlowChange(10, 1.5);
  // dFlow/dt = −0.5 ⇒ −kd·dFlow ≈ +5: the brake adds power to arrest the fall.
  assert.ok(withD > withoutD + 4, `D-term should add power on a falling flow: ${withoutD} -> ${withD}`);
});

test("kdTrim defaults to 0: omitting it leaves the pure-PI output unchanged", () => {
  const cfgNoKd: AdaptiveControllerConfig = { ...CONFIG, slewUpPerS: 100, slewDownPerS: 100 };
  delete (cfgNoKd as { kdTrim?: number }).kdTrim;
  const c = new AdaptiveController(cfgNoKd);
  c.seed(50);
  c.update(2.0, 1000);
  const omitted = c.update(2.5, 1000).output;
  assert.equal(omitted, outputOnFlowChange(0, 2.5), "kdTrim omitted must equal kdTrim: 0");
});

// ---------------------------------------------------------------------------
// Mid-shot setpoint retargeting (staged profiles)
// ---------------------------------------------------------------------------

test("setSetpoint retargets upward, slew-limited and state-preserving", () => {
  const c = make({ setpoint: 1.0 });
  const C = 0.03;
  c.seed(30);
  let power = 30;
  let flow = C * power;
  for (let i = 0; i < 200; i++) {
    const step = c.update(flow, 200);
    power = step.output;
    flow = C * power;
  }
  // Converged around flow 1.0 (power ~33). Now demand 3.0 g/s.
  c.setSetpoint(3.0);
  const before = power;
  const step = c.update(flow, 1000);
  // Rises toward the new target but no faster than slewUp (8%/s over 1s).
  assert.ok(step.output > before, `output should rise: ${before} -> ${step.output}`);
  assert.ok(step.output <= before + 8 + 1e-9, `slew-up cap violated: ${before} -> ${step.output}`);
});

// ---------------------------------------------------------------------------
// Auffuellen nach dem Bloom: kein mitgeschleppter Ueberschuss (Bezug #251)
// ---------------------------------------------------------------------------

/**
 * Nachgestellt nach #251 (Filter, HE-Korb, 0,1 bar): nach dem Bloom ist das
 * Bett leer, 15 s kommt nichts an, waehrend der Sollwert in 12 s auf 2,5 g/s
 * rampt. Danach eine Pumpe mit Totzone: Fluss = 0,13 · (Leistung − 12 %),
 * 1 s Traegheit — so liefern 36 % die gemessenen ~3,1 g/s.
 */
function simulateFillThenFlow(c: AdaptiveController) {
  const DT = 0.37;
  const SP = 2.5, RAMP_S = 12, FILL_S = 15, TAU = 1, K = 0.13, P0 = 12;
  c.seed(0);
  let flow = 0, power = 15;
  const trace: { t: number; flow: number; power: number }[] = [];
  for (let t = 0; t < FILL_S + 25; t += DT) {
    c.setSetpoint(Math.min(SP, (SP * t) / RAMP_S));
    const target = t < FILL_S ? 0 : K * Math.max(0, power - P0);
    flow += (target - flow) * (DT / TAU);
    power = c.update(flow, DT * 1000).output;
    trace.push({ t, flow, power });
  }
  const after = trace.filter((s) => s.t >= FILL_S + 10);
  return {
    peak: Math.max(...trace.map((s) => s.flow)),
    meanLate: after.reduce((a, s) => a + s.flow, 0) / after.length,
    maxPowerDuringFill: Math.max(...trace.filter((s) => s.t < FILL_S).map((s) => s.power)),
  };
}

test("⚠ nach dem Auffuellen haelt der Regler den Sollwert, statt den Ueberschuss mitzuschleppen", () => {
  const r = simulateFillThenFlow(make({ setpoint: 2.5, emaAlpha: 0.5, slewUpPerS: 20, kdTrim: 10 }));
  assert.ok(Math.abs(r.meanLate - 2.5) < 0.15, `Fluss 10 s nach Durchbruch ${r.meanLate.toFixed(2)} statt 2,5`);
});

test("beim Auffuellen darf die Leistung weiter steigen — sonst kaeme die Pumpe nie ueber ihre Anlaufschwelle", () => {
  const r = simulateFillThenFlow(make({ setpoint: 2.5, emaAlpha: 0.5, slewUpPerS: 20, kdTrim: 10 }));
  assert.ok(r.maxPowerDuringFill > 24, `Leistung beim Auffuellen nur ${r.maxPowerDuringFill.toFixed(1)} %`);
});

// ---------------------------------------------------------------------------
// Nach dem Schwall an der Untergrenze festgehangen (Bezug #246)
// ---------------------------------------------------------------------------

/**
 * Nachgestellt nach #246 (Espresso, Puck ohne Widerstand): bei 44 % liefen
 * 2,6 g/s, danach lag die Pumpe 15 s an der Untergrenze (15 %) und lieferte nur
 * 0,2–0,5 g/s statt 0,7. Strecke mit Totzone aus diesen zwei Punkten:
 * Fluss = 0,083 · (Leistung − 12,6 %), 1 s Traegheit.
 */
function simulateAfterGush(c: AdaptiveController) {
  const DT = 0.37, K = 0.083, P0 = 12.6, TAU = 1, SP = 0.7;
  c.seed(44);                 // Ĉ wie nach dem Schwall gelernt: 2,6 g/s bei 44 %
  c.update(2.6, DT * 1000);
  c.setSetpoint(SP);
  let flow = 2.6, power = 44;
  const trace: { t: number; flow: number; power: number }[] = [];
  for (let t = 0; t < 25; t += DT) {
    flow += (K * Math.max(0, power - P0) - flow) * (DT / TAU);
    power = c.update(flow, DT * 1000).output;
    trace.push({ t, flow, power });
  }
  const settled = trace.find((s, i) => trace.slice(i).every((x) => Math.abs(x.flow - SP) < 0.15));
  return {
    settleS: settled ? settled.t : Infinity,
    peakAfter: Math.max(...trace.filter((s) => s.t > 3).map((s) => s.flow)),
    meanLate: trace.filter((s) => s.t >= 15).reduce((a, s, _, arr) => a + s.flow / arr.length, 0),
  };
}

test("⚠ nach einem Schwall findet der Regler von der Untergrenze zurueck zum Sollwert", () => {
  const r = simulateAfterGush(make({ setpoint: 2.6, emaAlpha: 0.5, slewUpPerS: 20, kdTrim: 10 }));
  assert.ok(r.settleS < 10, `erst nach ${r.settleS.toFixed(1)} s im Band ±0,15 um 0,7 g/s`);
  assert.ok(r.peakAfter < 1.1, `Ueberschwinger beim Zurueckfinden: ${r.peakAfter.toFixed(2)} g/s`);
  assert.ok(Math.abs(r.meanLate - 0.7) < 0.1, `spaeter Mittelwert ${r.meanLate.toFixed(2)} g/s`);
});

/*
 * Zeitversetztes Lernen (learnDelayMs), nachgestellt nach #255/#256: der
 * Tassenfluss folgt der Leistung erst nach ~1 s (Puck → Tasse → Waage). Am
 * Uebergang liegt die Leistung 25 % zu hoch (Schwung), danach Stufen
 * 1,1 → 1,0 → 0,7 g/s wie bei Gagne bzw. Decaf Flow.
 */
function simulateDeadTime(learnDelayMs: number) {
  const DT = 0.35, K = 0.04, P0 = 12, TAU = 0.8, DEAD = 1.05;
  const c = make({ setpoint: 1.0, emaAlpha: 0.5, slewUpPerS: 20, kdTrim: 10, learnDelayMs });
  const hist: number[] = [];
  let power = P0 + (1.0 / K) * 1.25;
  c.seed(power);
  let flow = 1.0;
  const tr: { t: number; flow: number; sp: number }[] = [];
  for (let t = 0; t < 32; t += DT) {
    hist.push(power);
    const lagged = hist[Math.max(0, hist.length - 1 - Math.round(DEAD / DT))];
    flow += (K * Math.max(0, lagged - P0) - flow) * (DT / TAU);
    const sp = t < 8 ? 1.1 : t < 20 ? 1.0 : 0.7;
    c.setSetpoint(sp);
    power = c.update(flow, DT * 1000).output;
    tr.push({ t, flow, sp });
  }
  const minIn = (a: number, b: number) => Math.min(...tr.filter((r) => r.t >= a && r.t < b).map((r) => r.flow));
  return { minStage2: minIn(8, 20), minAfterDrop: minIn(20, 32) };
}

test("⚠ zeitversetztes Lernen: kein Absturz beim Stufenwechsel, der Fluss-Ausstieg 0,85 bleibt still", () => {
  const now = simulateDeadTime(0);
  const aligned = simulateDeadTime(1500);
  assert.ok(aligned.minStage2 > 0.9, `Stufe 1,0 g/s faellt auf ${aligned.minStage2.toFixed(2)}`);
  assert.ok(
    aligned.minAfterDrop > now.minAfterDrop + 0.1,
    `Wechsel 1,0 → 0,7: ${now.minAfterDrop.toFixed(2)} ohne, ${aligned.minAfterDrop.toFixed(2)} mit Zeitversatz`,
  );
});

test("learnDelayMs fehlt oder 0: Regler verhaelt sich exakt wie bisher", () => {
  const a = simulateDeadTime(0);
  const c1 = make({ setpoint: 1.0 }), c2 = make({ setpoint: 1.0, learnDelayMs: 0 });
  c1.seed(40); c2.seed(40);
  for (const f of [0.2, 0.6, 1.1, 1.3, 0.9]) {
    assert.equal(c1.update(f, 350).output, c2.update(f, 350).output);
  }
  assert.ok(Number.isFinite(a.minStage2));
});
