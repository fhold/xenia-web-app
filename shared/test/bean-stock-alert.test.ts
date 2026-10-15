/**
 * Unit tests for isStockDepleted — Schwelle ist die letzte Dosis, nicht 0.
 * Runner: node:test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isStockDepleted } from "../src/coffee.js";

test("ohne Restbestand kein Signal (keine Beutelgroesse gepflegt)", () => {
  assert.equal(isStockDepleted(null, 12), false);
});

test("voller Beutel", () => {
  assert.equal(isStockDepleted(250, 12), false);
});

test("Rest reicht genau fuer einen Bezug", () => {
  assert.equal(isStockDepleted(12, 12), false);
});

test("Rest reicht nicht mehr fuer einen Bezug", () => {
  assert.equal(isStockDepleted(11.9, 12), true);
});

test("negativer Rest ist immer aufgebraucht", () => {
  assert.equal(isStockDepleted(-206, 12), true);
});

test("ohne bekannte Dosis erst bei 0", () => {
  assert.equal(isStockDepleted(5, null), false);
  assert.equal(isStockDepleted(0, null), true);
  assert.equal(isStockDepleted(-1, null), true);
});

test("Dosis 0 zaehlt als unbekannt", () => {
  assert.equal(isStockDepleted(5, 0), false);
  assert.equal(isStockDepleted(0, 0), true);
});
