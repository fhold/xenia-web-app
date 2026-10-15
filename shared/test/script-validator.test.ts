/**
 * Tests for validateScript() (SE-1 Discovery Q5 — safety/validity rules).
 * Built-in runner, no dependency:  node --test test/script-validator.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScript } from "../src/script-parser.ts";
import { validateScript } from "../src/script-validator.ts";

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);
const v = (raw: string) => validateScript(parseScript(raw));

// All 14 live scripts (byte-exact from FW 4.133) must be valid — no errors.
const LIVE_RAWS: string[] = [
  "1;13;4 9000 3000;12 6000;3 20 35000;12 60000;17;7;",
  "1;12 1000;13;4 2000 10000;27 20;17;7;",
  "1;25 80;9 0;8 0;13;4 9000 5000;12 45000;17;7;",
  "1;13;4 6000 2000;12 60000;7;",
  "1;25 93;13;4 2500 13000;4 6500 8000;4 5000 12000;4 4000 30000;31;12 60000;17;7;",
  "1;13;3 100 10000;12 12000;14;17;7;",
  "1;13;4 6000 5000;12 40000;17;7;",
  "1;13;4 700 20000;12 60000;7;",
  "1;13;4 6000 3000;12 9000;6;12 30000;4 8000 3000;12 35000;17;7;",
  "1;13;4 1100 1000;12 15000;4 9000 2000;12 5000;4 4000 45000;12 60000;17;7;",
  "1;13;4 9000 1000;12 60000;17;7;",
  "1;13;4 400 15000;12 15000;6;12 30000;7;",
  "1;13;4 9000 1000;12 20000;6;15;12 20000;16;4 9000 1000;12 15000;6;15;12 20000;16;4 9000 1000;12 15000;6;15;12 20000;16;4 9000 1000;12 15000;6;15;12 20000;16;4 9000 1000;12 20000;6;15;12 20000;16;4 9000 1000;12 20000;17;20 1 1000;20 1 1000;7;",
  "1;13;4 3000 1000;12 20000;4 9000 2000;12 10000;4 4000 45000;12 60000;17;7;",
];

test("all 14 live scripts are valid (no errors)", () => {
  for (const raw of LIVE_RAWS) {
    const r = v(raw);
    assert.equal(r.ok, true, `expected valid: ${raw}\n  errors: ${JSON.stringify(r.errors)}`);
    assert.equal(r.errors.length, 0);
  }
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test("empty script -> EMPTY_SCRIPT, not ok", () => {
  const r = v("");
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r.errors), ["EMPTY_SCRIPT"]);
});

test("missing Cmd 1 start -> MISSING_SCRIPT_START", () => {
  const r = v("13;3 70 5000;17;7;");
  assert.ok(codes(r.errors).includes("MISSING_SCRIPT_START"));
  assert.equal(r.ok, false);
});

test("missing Cmd 7 end -> MISSING_SCRIPT_END", () => {
  const r = v("1;13;17;");
  assert.ok(codes(r.errors).includes("MISSING_SCRIPT_END"));
});

test("unknown Cmd ID -> UNKNOWN_CMD", () => {
  const r = v("1;99 1;17;7;");
  assert.ok(codes(r.errors).includes("UNKNOWN_CMD"));
});

test("no stop mechanism (no Cmd 17, no safety timer) -> NO_STOP_MECHANISM", () => {
  const r = v("1;13;3 70 5000;7;");
  assert.ok(codes(r.errors).includes("NO_STOP_MECHANISM"));
});

test("short Cmd 12 before Cmd 7 is NOT a safety timer -> NO_STOP_MECHANISM", () => {
  const r = v("1;13;3 70 5000;12 5000;7;"); // 5s <= 20s threshold
  assert.ok(codes(r.errors).includes("NO_STOP_MECHANISM"));
});

test("long Cmd 12 before Cmd 7 IS a safety timer -> valid", () => {
  const r = v("1;13;3 70 5000;12 60000;7;"); // 60s > 20s
  assert.equal(r.ok, true);
  assert.ok(!codes(r.errors).includes("NO_STOP_MECHANISM"));
});

test("Cmd 17 alone satisfies the stop requirement -> valid", () => {
  const r = v("1;13;3 70 5000;17;7;");
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

test("Cmd 27 with leading ~1s tara wait -> no tara warning, but Bookoo info", () => {
  const r = v("1;12 1000;13;4 2000 10000;27 20;17;7;");
  assert.equal(r.ok, true);
  assert.ok(!codes(r.warnings).includes("CMD27_NO_TARA_WAIT"));
  assert.ok(codes(r.warnings).includes("CMD27_NEEDS_BOOKOO"));
});

test("Cmd 27 without leading tara wait -> CMD27_NO_TARA_WAIT", () => {
  const r = v("1;13;27 20;17;7;");
  assert.ok(codes(r.warnings).includes("CMD27_NO_TARA_WAIT"));
  assert.equal(r.ok, true); // still valid, just flagged
});

test("no Cmd 27 -> no Bookoo warnings", () => {
  const r = v("1;13;4 6000 5000;12 40000;17;7;");
  assert.ok(!codes(r.warnings).includes("CMD27_NEEDS_BOOKOO"));
  assert.ok(!codes(r.warnings).includes("CMD27_NO_TARA_WAIT"));
});

test("pump power out of range -> PUMP_POWER_RANGE", () => {
  const r = v("1;13;3 150 5000;17;7;");
  assert.ok(codes(r.warnings).includes("PUMP_POWER_RANGE"));
});

test("non-positive duration -> DURATION_NONPOSITIVE", () => {
  const r = v("1;13;3 70 0;17;7;");
  assert.ok(codes(r.warnings).includes("DURATION_NONPOSITIVE"));
});

test("pressure over 12 bar -> PRESSURE_RANGE", () => {
  const r = v("1;13;4 13000 5000;17;7;");
  assert.ok(codes(r.warnings).includes("PRESSURE_RANGE"));
});
