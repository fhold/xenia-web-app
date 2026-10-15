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
} from "../src/pump-curve.js";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("Kennlinie: Leistung fuer Zulauf und Druck (P = 3,26·p + 9,5·Q + 9,4)", () => {
  near(powerForInflow(DEFAULT_PUMP_CURVE, 0, 3.5), 42.65);
  near(powerForInflow(DEFAULT_PUMP_CURVE, 2, 2), 34.92);
  // negativer Druck (Sensorrauschen) zaehlt als 0
  near(powerForInflow(DEFAULT_PUMP_CURVE, -0.1, 1), 18.9);
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
