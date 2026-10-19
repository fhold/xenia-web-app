/**
 * Unit tests for the BBW arming gate (Spec §4.12 / Auftrag 3m).
 *
 * Runner: node:test (NOT vitest) — run with `node --import tsx --test`.
 * Seit Schnitt 3 sagt das Profil, ob es ein Bezug ist; das Skript nur, ob es
 * die Pumpe ansteuert. Nur ein Bezug mit Pumpe schaltet den App-Stopp scharf —
 * so kann ein Spuellauf das Nachlauf-Lernen (residual_lag) nie verfaelschen.
 * Die Skript-Kategorie schlaegt nur noch die Art vor (Uebersteuerung vor Automatik).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveCategory, profileArmsBbw } from "../src/bbw-arming.js";

test("Bezug mit Pumpe schaltet BBW scharf", () => {
  assert.equal(profileArmsBbw({ kind: "brew", hasPumpAction: true }), true);
});

test("Wartung schaltet BBW nie scharf — auch mit Pumpe (Rueckspuelen pumpt)", () => {
  assert.equal(profileArmsBbw({ kind: "maintenance", hasPumpAction: true }), false);
  assert.equal(profileArmsBbw({ kind: "maintenance", hasPumpAction: false }), false);
});

test("Messlauf verhaelt sich wie ein Bezug: mit Pumpe scharf, ohne nicht", () => {
  assert.equal(profileArmsBbw({ kind: "test", hasPumpAction: true }), true);
  assert.equal(profileArmsBbw({ kind: "test", hasPumpAction: false }), false);
});

test("Bezug ohne Pumpe schaltet nicht scharf — das Profil allein reicht nicht", () => {
  assert.equal(profileArmsBbw({ kind: "brew", hasPumpAction: false }), false);
});

test("Skript-Kategorie: null/unknown fallen zusammen, Uebersteuerung vor Automatik", () => {
  assert.equal(effectiveCategory({ categoryAuto: null }), "unknown");
  assert.equal(effectiveCategory({ categoryAuto: "unknown" }), "unknown");
  assert.equal(effectiveCategory({ categoryAuto: "maintenance", categoryOverride: "brew" }), "brew");
  assert.equal(effectiveCategory({ categoryAuto: "brew", categoryOverride: "maintenance" }), "maintenance");
});
