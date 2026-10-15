/**
 * Unit tests for computeRemainingG — Restbestand aus Bezuegen abgeleitet,
 * mit manuellem Korrektur-Anker. Runner: node:test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRemainingG } from "../src/coffee.js";

const ANCHOR_AT = Date.parse("2026-07-20T10:00:00Z");

test("kein Anker -> Beutelgroesse minus alle Bezuege", () => {
  assert.equal(computeRemainingG(250, null, null, 168), 82);
});

test("Deepwood: mehr bezogen als der Beutel hergibt -> negativ, nicht geklemmt", () => {
  // 37 Bezuege a 12 g = 444 g aus einem 250-g-Beutel.
  assert.equal(computeRemainingG(250, 150, null, 444), -194);
});

test("gespeicherter remaining_g ohne Anker-Zeitpunkt wird ignoriert", () => {
  // Der Altbestand (von Hand eingetragene 150 g) darf die Rechnung nicht
  // verfaelschen, solange kein Anker-Zeitpunkt existiert.
  assert.equal(computeRemainingG(250, 150, null, 0), 250);
});

test("manueller Anker gilt: nur Bezuege danach zaehlen", () => {
  assert.equal(computeRemainingG(250, 80, ANCHOR_AT, 24), 56);
});

test("Anker direkt nach dem Setzen -> unveraendert", () => {
  assert.equal(computeRemainingG(250, 80, ANCHOR_AT, 0), 80);
});

test("Anker 0 ist ein echter Anker, kein leeres Feld", () => {
  assert.equal(computeRemainingG(250, 0, ANCHOR_AT, 12), -12);
});

test("geleertes Feld mit Anker-Zeitpunkt -> kein Bestand berechenbar", () => {
  assert.equal(computeRemainingG(250, null, ANCHOR_AT, 24), null);
});

test("ohne Beutelgroesse und ohne Anker -> null", () => {
  assert.equal(computeRemainingG(null, null, null, 24), null);
});

test("Gleitkomma-Reste werden auf 0,1 g gerundet", () => {
  assert.equal(computeRemainingG(250, null, null, 18.3 + 18.3 + 18.3), 195.1);
});
