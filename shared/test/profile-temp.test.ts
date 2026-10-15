/**
 * Unit tests for the per-profile target brew temperature validator (PT-1).
 *
 * Runner: node:test (NOT vitest) — run with `node --import tsx --test`.
 * Pins the pure decision shared by the backend profile routes and the frontend
 * ProfileEditor: null/absent → no target; finite 70–110 °C → accepted; anything
 * else (non-numeric, NaN, out of range typo like 960) → rejected so a
 * persistent profile field is never silently nulled.
 *
 * Also pins the toProfile mapping contract (DB NULL → null, number → number):
 * the repo maps `row.target_temp_c ?? null`, i.e. exactly this null/number set.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTargetTempC,
  TARGET_TEMP_MIN_C,
  TARGET_TEMP_MAX_C,
} from "../src/profile-temp.js";

test("null → null (no target)", () => {
  assert.deepEqual(parseTargetTempC(null), { ok: true, value: null });
});

test("undefined → null (field absent)", () => {
  assert.deepEqual(parseTargetTempC(undefined), { ok: true, value: null });
});

test("valid number within range is accepted", () => {
  assert.deepEqual(parseTargetTempC(93), { ok: true, value: 93 });
  assert.deepEqual(parseTargetTempC(96.5), { ok: true, value: 96.5 });
});

test("lower bound (70) is accepted", () => {
  assert.deepEqual(parseTargetTempC(TARGET_TEMP_MIN_C), { ok: true, value: 70 });
});

test("upper bound (110) is accepted", () => {
  assert.deepEqual(parseTargetTempC(TARGET_TEMP_MAX_C), { ok: true, value: 110 });
});

test("just below the lower bound is rejected", () => {
  assert.equal(parseTargetTempC(69.9).ok, false);
});

test("just above the upper bound is rejected", () => {
  assert.equal(parseTargetTempC(110.1).ok, false);
});

test("a typo like 960 is rejected (out of range)", () => {
  const r = parseTargetTempC(960);
  assert.equal(r.ok, false);
});

test("non-numeric values are rejected", () => {
  assert.equal(parseTargetTempC("abc").ok, false);
  assert.equal(parseTargetTempC("93").ok, false); // strings are not coerced
  assert.equal(parseTargetTempC(NaN).ok, false);
  assert.equal(parseTargetTempC(Infinity).ok, false);
  assert.equal(parseTargetTempC(true).ok, false);
  assert.equal(parseTargetTempC({}).ok, false);
});

test("toProfile mapping contract: NULL → null, number → number", () => {
  // The repo maps `row.target_temp_c ?? null`; assert the value set matches.
  assert.equal(parseTargetTempC(null).ok && parseTargetTempC(null).value, null);
  const r = parseTargetTempC(93);
  assert.equal(r.ok && r.value, 93);
});
