/**
 * Unit tests for the brew sub-phase classifier (pre-infusion vs extraction).
 * Runner: node:test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractionStarted,
  brewSubPhase,
  EXTRACTION_PRESSURE_BAR,
  EXTRACTION_MIN_OUTPUT_G,
} from "../src/brew-phase.js";

test("starts in pre-infusion (low pressure, no output)", () => {
  assert.equal(extractionStarted(false, 1.5, 0), false);
  assert.equal(brewSubPhase(false), "preinfusion");
});

test("pressure threshold starts extraction (normal profile)", () => {
  assert.equal(extractionStarted(false, EXTRACTION_PRESSURE_BAR, 0), true);
  assert.equal(extractionStarted(false, 9, 0), true);
  assert.equal(brewSubPhase(true), "extraction");
});

test("low-pressure profile (Decaf ~4 bar): output on the scale starts extraction", () => {
  // Never reaches 5 bar, but coffee is flowing → extraction.
  assert.equal(extractionStarted(false, 4.1, 0.2), false); // pre-infusion still
  assert.equal(extractionStarted(false, 4.1, EXTRACTION_MIN_OUTPUT_G), true);
});

test("monotonic latch: stays extraction when pressure later drops (declining)", () => {
  assert.equal(extractionStarted(true, 2, 0), true);
  assert.equal(extractionStarted(true, null, null), true);
});

test("nulls count as not-yet", () => {
  assert.equal(extractionStarted(false, null, null), false);
});

test("pressure null but output present → extraction", () => {
  assert.equal(extractionStarted(false, null, 5), true);
});
