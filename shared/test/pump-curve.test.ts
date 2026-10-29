/**
 * Pumpenkennlinie und Preinfusion ueber den rechnerischen Zulauf (shared/src/pump-curve.ts).
 * Runner: node:test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PUMP_CURVE,
  parsePumpCurve,
  powerForInflow,
  preinfusionPower,
  preinfusionArrivalGs,
  PREINFUSION_POWER_CAP,
  PREINFUSION_FAST_FILL_POWER,
  PREINFUSION_FILL_MLS,
} from "../src/pump-curve.js";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("Kennlinie: Leistung fuer Zulauf und Druck (P = 3,26·p + 9,5·Q + 9,4)", () => {
  near(powerForInflow(DEFAULT_PUMP_CURVE, 0, 3.5), 42.65);
  near(powerForInflow(DEFAULT_PUMP_CURVE, 2, 2), 34.92);
  // negativer Druck (Sensorrauschen) zaehlt als 0
  near(powerForInflow(DEFAULT_PUMP_CURVE, -0.1, 1), 18.9);
});

test("Kennlinie ueber 7 bar: die Pumpe foerdert je bar darueber 0,1 ml/s weniger", () => {
  // bis 7 bar die Gerade
  near(powerForInflow(DEFAULT_PUMP_CURVE, 7, 2), 9.4 + 3.26 * 7 + 9.5 * 2);
  // bei 9 bar fehlen 0,2 ml/s → +1,9 % Leistung (#298 brauchte +2,2 % bei 8,65 bar)
  near(powerForInflow(DEFAULT_PUMP_CURVE, 9, 2) - (9.4 + 3.26 * 9 + 9.5 * 2), 1.9);
});

test("Preinfusion: fuellt bis 1 bar mit 3,5 ml/s, danach saettigt sie je nach Sanftheit", () => {
  const c = DEFAULT_PUMP_CURVE;
  near(preinfusionPower(c, undefined, 0.5, 5000), 9.4 + 3.26 * 0.5 + 9.5 * 3.5);
  near(preinfusionPower(c, "normal", 2, 5000), 34.92);
  assert.ok(preinfusionPower(c, "gentle", 2, 5000) < preinfusionPower(c, "normal", 2, 5000));
  assert.ok(preinfusionPower(c, "brisk", 2, 5000) > preinfusionPower(c, "normal", 2, 5000));
});

test("Preinfusion: sanfter Anlauf und feste Obergrenze", () => {
  const c = DEFAULT_PUMP_CURVE;
  near(preinfusionPower(c, "normal", 0, 0), 0);
  near(preinfusionPower(c, "normal", 0, 1500), PREINFUSION_POWER_CAP / 2);
  near(preinfusionPower(c, "brisk", 12, 10000), PREINFUSION_POWER_CAP);
});

test("Preinfusion schnell fuellen: volle Pumpe bis 1 bar, danach saettigt sie wie gewaehlt", () => {
  const c = DEFAULT_PUMP_CURVE;
  near(preinfusionPower(c, "normal", 0.5, 5000, undefined, "fast"), PREINFUSION_FAST_FILL_POWER);
  // sanfter Anlauf bis zur vollen Pumpe
  near(preinfusionPower(c, "normal", 0, 1500, undefined, "fast"), PREINFUSION_FAST_FILL_POWER / 2);
  // ab Gegendruck wie ohne schnelles Fuellen — auch die Obergrenze 60 % gilt wieder
  near(preinfusionPower(c, "gentle", 2, 5000, undefined, "fast"), preinfusionPower(c, "gentle", 2, 5000));
  near(preinfusionPower(c, "brisk", 12, 10000, undefined, "fast"), PREINFUSION_POWER_CAP);
  // normal = wie bisher
  near(preinfusionPower(c, "normal", 0.5, 5000, undefined, "normal"), preinfusionPower(c, "normal", 0.5, 5000));
});

test("Preinfusion ohne Bremse (none): fuellt bis zum Ausstieg weiter — schnell mit voller Pumpe, sonst mit 3,5 ml/s", () => {
  const c = DEFAULT_PUMP_CURVE;
  near(preinfusionPower(c, "none", 3.8, 10000, undefined, "fast"), PREINFUSION_FAST_FILL_POWER);
  near(preinfusionPower(c, "none", 2, 5000), powerForInflow(c, 2, PREINFUSION_FILL_MLS));
  // die Obergrenze 60 % gilt weiter, nur das schnelle Fuellen geht darueber
  near(preinfusionPower(c, "none", 12, 10000), PREINFUSION_POWER_CAP);
});

test("Preinfusion endet, wenn 90 % des Startflusses der naechsten Flussstufe ankommen", () => {
  near(preinfusionArrivalGs({ kind: "flow", targetFlowGs: 1.1, exit: {} })!, 0.99);
  assert.equal(preinfusionArrivalGs({ kind: "power", power: 0, exit: { seconds: 10 } }), null);
  assert.equal(preinfusionArrivalGs(undefined), null);
});

test("Kennlinie aus der Einstellung — Unbrauchbares faellt auf den Standard zurueck", () => {
  assert.deepEqual(parsePumpCurve('{"perBar":3,"perMlS":10,"offset":8}'), { perBar: 3, perMlS: 10, offset: 8 });
  assert.equal(parsePumpCurve(null), DEFAULT_PUMP_CURVE);
  assert.equal(parsePumpCurve("kaputt"), DEFAULT_PUMP_CURVE);
  assert.equal(parsePumpCurve('{"perBar":3,"perMlS":0,"offset":8}'), DEFAULT_PUMP_CURVE);
});
