/**
 * Druckregelung der App-Druckstufen (shared/src/pressure-lead-controller.ts).
 * Runner: node:test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PUMP_CURVE as C, powerForInflow } from "../src/pump-curve.js";
import { DEFAULT_PRESSURE_LEAD, PressureLeadController, type PressureLeadStep } from "../src/pressure-lead-controller.js";

const TICK_MS = 370;

/** Druckverlauf im Abfragetakt einspeisen; liefert die Schritte. */
function run(
  ctrl: PressureLeadController,
  pressures: number[],
  { soll, outflow = 0, sollAhead = soll }: { soll: number; outflow?: number; sollAhead?: number },
): PressureLeadStep[] {
  return pressures.map((p, k) =>
    ctrl.update({ nowMs: k * TICK_MS, pressureBar: p, outflowMlS: outflow, soll, sollAhead, dtS: TICK_MS / 1000 }),
  );
}
const make = () => new PressureLeadController(C, DEFAULT_PRESSURE_LEAD);
/** Zulauf (ml/s), den die Leistung bei diesem Druck laut Kennlinie bringt. */
const inflowOf = (s: PressureLeadStep) => (s.output - C.offset - C.perBar * s.predicted) / C.perMlS;

test("Halten: auf dem Soll bei ruhigem Puck genau der Zulauf, der abfliesst", () => {
  const s = run(make(), [9, 9, 9, 9], { soll: 9, outflow: 2 });
  for (const x of s) assert.ok(Math.abs(x.output - powerForInflow(C, 9, 2)) < 1e-9, `${x.output}`);
});

test("Trockener Puck weit unter dem Soll: volle Pumpe zum Fuellen", () => {
  const s = run(make(), [0, 0, 0], { soll: 1.1 });
  assert.equal(s.at(-1)!.output, DEFAULT_PRESSURE_LEAD.outMax);
});

test("Kurz vor einem niedrigen Soll: nur so viel Zulauf, wie ein ploetzlich steifer Puck vertraegt", () => {
  // #295: mit ~4,5 ml/s ins Steifwerden bei ~1 bar → 5,3 bar. Hier hoechstens ~3 ml/s, und
  // je naeher am Soll, desto weniger.
  const at = (p: number) => inflowOf(run(make(), [p, p, p], { soll: 1.1 }).at(-1)!);
  assert.ok(at(0.9) < 3, `bei 0,9 bar ${at(0.9).toFixed(2)} ml/s`);
  assert.ok(at(1.05) < at(0.9));
  assert.ok(at(0.5) > at(0.9));
});

test("Schneller Anstieg: sie nimmt zurueck, bevor der Druck das Soll erreicht", () => {
  const rising = run(make(), [5.4, 6.5, 7.6], { soll: 9, outflow: 1.5 }).at(-1)!;
  const flat = run(make(), [7.6, 7.6, 7.6], { soll: 9, outflow: 1.5 }).at(-1)!;
  // 3 bar/s Steigung, 0,35 s vorausgerechnet: erwartet ~8,6 bei gemessen 7,6
  assert.ok(rising.predicted > 8.5, `erwartet ${rising.predicted.toFixed(2)} bar`);
  assert.ok(rising.output < flat.output, `${rising.output} ≥ ${flat.output}`);
});

test("Ueber dem Soll: weniger Zulauf als abfliesst", () => {
  const s = run(make(), [9.6, 9.6, 9.6], { soll: 9, outflow: 2 }).at(-1)!;
  assert.ok(inflowOf(s) < 2, `${inflowOf(s).toFixed(2)} ml/s`);
});

test("Fallende Rampe: die Leistung geht mit dem Soll herunter", () => {
  const ctrl = make();
  const outs = [7, 6.9, 6.8, 6.7, 6.6].map((p, k) =>
    ctrl.update({ nowMs: k * TICK_MS, pressureBar: p, outflowMlS: 1.5, soll: p, sollAhead: p - 0.13, dtS: TICK_MS / 1000 }).output);
  for (let k = 1; k < outs.length; k++) assert.ok(outs[k]! < outs[k - 1]!, outs.join(", "));
});

test("Integral: eine bleibende kleine Abweichung hebt die Leistung nach und nach", () => {
  const s = run(make(), Array(12).fill(8.8), { soll: 9, outflow: 2 });
  assert.ok(s.at(-1)!.output > s[0]!.output + 2, `${s[0]!.output} → ${s.at(-1)!.output}`);
});

/** Der Regler vor #307: ausserhalb des Bands nie ein Integral. */
const makeBandOnly = () => new PressureLeadController(C, { ...DEFAULT_PRESSURE_LEAD, stillSlope: 0 });

test("Ueber dem Soll festgefahren (#307): das Integral nimmt die Leistung auch ausserhalb des Bands zurueck", () => {
  // 9,4 bar bei 7,8 Soll — 1,6 bar ueber dem Band von 1,17 bar; der Druck steht.
  const p = Array(12).fill(9.4);
  const now = run(make(), p, { soll: 7.8, outflow: 0.85 }).at(-1)!;
  const before = run(makeBandOnly(), p, { soll: 7.8, outflow: 0.85 }).at(-1)!;
  assert.ok(now.output < before.output - 3, `${before.output} → ${now.output}`);
});

test("Ueber dem Soll, aber der Druck faellt schon: ausserhalb des Bands wie bisher", () => {
  const p = [9.4, 9.2, 9.0, 8.8, 8.6, 8.4, 8.2];
  const now = run(make(), p, { soll: 7.8, outflow: 0.85 });
  const before = run(makeBandOnly(), p, { soll: 7.8, outflow: 0.85 });
  // bis 9,0 bar liegt der Druck mehr als 1,17 bar ueber dem Soll
  for (let k = 0; k < 3; k++) assert.equal(now[k]!.output, before[k]!.output, `Takt ${k}`);
});

test("Unter dem Soll festgefahren (Fuellen): weiterhin kein Integral ausserhalb des Bands", () => {
  const p = Array(12).fill(0.2);
  const now = run(make(), p, { soll: 3 });
  const before = run(makeBandOnly(), p, { soll: 3 });
  assert.deepEqual(now.map((s) => s.output), before.map((s) => s.output));
});

test("Integral laeuft weit unter dem Soll nicht auf: danach haelt sie mit der reinen Kennlinie", () => {
  const ctrl = make();
  // langes Fuellen ausserhalb des Bands (1,1 bar Soll, 0,2 bar im Puck)
  run(ctrl, Array(20).fill(0.2), { soll: 1.1 });
  // spaeter ruhig auf dem Soll — die Fuell-Takte liegen nicht mehr im Steigungsfenster
  let hold!: PressureLeadStep;
  for (let k = 0; k < 3; k++) {
    hold = ctrl.update({ nowMs: 20_000 + k * TICK_MS, pressureBar: 1.1, outflowMlS: 0.5, soll: 1.1, sollAhead: 1.1, dtS: TICK_MS / 1000 });
  }
  assert.ok(Math.abs(hold.output - powerForInflow(C, 1.1, 0.5)) < 1e-9, `${hold.output}`);
});

test("Integral rechnet mit dem erwarteten Druck: beim schnellen Anstieg ins Soll zieht es nicht auf", () => {
  const ctrl = make();
  run(ctrl, [6.0, 6.8, 7.6, 8.4], { soll: 9, outflow: 2 });
  const hold = ctrl.update({ nowMs: 4 * TICK_MS, pressureBar: 9, outflowMlS: 2, soll: 9, sollAhead: 9, dtS: TICK_MS / 1000 });
  // die Steigung steckt noch im Fenster: erwartet > 9 bar, also eher weniger Leistung als zum Halten
  assert.ok(hold.output <= powerForInflow(C, hold.predicted, 2) + 1e-9, `${hold.output}`);
});

test("Leistung bleibt in den Grenzen", () => {
  const lo = run(make(), [12, 12, 12], { soll: 2 }).at(-1)!;
  assert.equal(lo.output, DEFAULT_PRESSURE_LEAD.outMin);
});
