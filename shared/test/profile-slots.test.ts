/**
 * Profilliste und Start-Dialog fragen dieselbe Funktion, ob es einen 2×-Platz
 * gibt. Anlass: die alte Auswahl am Dashboard-Chip kannte nur das Double-Skript.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasDoubleSlot, startVariants, effectiveVariant, variantRunsInApp, shotSizeForBasket, variantForSlot } from "../src/profile-slots.js";
import type { BrewProfile, ProfileVariant } from "../src/types.js";

const steps: BrewProfile = { version: 1, steps: [{ kind: "flow", targetFlowGs: 1.4, exit: {} }] };

test("App-Profil: 2× gibt es genau dann, wenn ein 2×-Yield gesetzt ist", () => {
  assert.equal(hasDoubleSlot({ brewSteps: steps, scriptIdDouble: null, yieldTargetDoubleG: 40 }), true);
  assert.equal(hasDoubleSlot({ brewSteps: steps, scriptIdDouble: null, yieldTargetDoubleG: null }), false);
});

test("Skript-Profil: 2× gibt es genau dann, wenn ein Double-Skript hinterlegt ist", () => {
  assert.equal(hasDoubleSlot({ brewSteps: null, scriptIdDouble: 28, yieldTargetDoubleG: 36 }), true);
  // Ein 2×-Yield ohne Double-Skript startet nichts.
  assert.equal(hasDoubleSlot({ brewSteps: null, scriptIdDouble: null, yieldTargetDoubleG: 36 }), false);
});

// --- Varianten (Schnitt 3d) ---------------------------------------------------


const v = (id: number, sortOrder: number, extra: Partial<ProfileVariant> = {}): ProfileVariant => ({
  id, name: `V${id}`, sortOrder, defaultBasketId: null, yieldG: 20, scriptId: null, brewSteps: null, sameAsId: null, legacySlot: null, ...extra,
});

test("Varianten: Reihenfolge, „wie Variante X“, App oder Skript", () => {
  const steps = { version: 1 as const, steps: [{ kind: "flow" as const, targetFlowGs: 1.4, exit: {} }] };
  const a = v(1, 0, { brewSteps: steps, legacySlot: "single" });
  const b = v(2, 1, { sameAsId: 1, yieldG: 36, legacySlot: "double" });
  const c = v(3, 2, { scriptId: 30 });
  const p = { variants: [c, b, a] };
  assert.deepEqual(startVariants(p).map((x) => x.id), [1, 2, 3]);
  assert.equal(effectiveVariant(p, b).id, 1);
  assert.equal(variantRunsInApp(p, b), true); // faehrt die Stufen von Variante 1
  assert.equal(variantRunsInApp(p, c), false);
  assert.equal(variantForSlot(p, "double")?.id, 2);
  assert.equal(variantForSlot({ variants: [c] }, "single"), null);
});

test("Sieb → shot_size: nur Doppel ist Doppel, HE zählt als Einzel", () => {
  assert.equal(shotSizeForBasket("double"), "double");
  assert.equal(shotSizeForBasket("single"), "single");
  assert.equal(shotSizeForBasket("he"), "single");
  assert.equal(shotSizeForBasket(null), "single");
});

