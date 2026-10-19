/**
 * Was als "bewertet" gilt.
 *
 * Anlass: ein Bezug mit Channeling-Marke und Mahlgrad-Hinweis stand in der
 * Historie als "nicht bewertet", im Detail aber als bewertet — die App hatte
 * vier verschiedene Definitionen.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { hasRating, ratedWithoutStars, extractionMarks } from "../../shared/src/shot-rating.js";
import type { RatedFields } from "../../shared/src/shot-rating.js";

const leer: RatedFields = {
  rating: null, acidity: null, bitterness: null,
  extractionUnder: false, extractionOver: false, channeling: false,
  tasteTags: null, grindNote: null,
};

test("ohne jede Angabe: nicht bewertet", () => {
  assert.equal(hasRating(leer), false);
  assert.equal(ratedWithoutStars(leer), false);
});

test("Sterne allein genuegen", () => {
  assert.equal(hasRating({ ...leer, rating: 4 }), true);
  assert.equal(ratedWithoutStars({ ...leer, rating: 4 }), false);
});

test("⚠ Channeling und Mahlgrad-Hinweis sind Bewertungen — genau der gemeldete Fall", () => {
  assert.equal(hasRating({ ...leer, channeling: true }), true);
  assert.equal(hasRating({ ...leer, grindNote: "finer" }), true);
  assert.equal(ratedWithoutStars({ ...leer, channeling: true }), true);
});

test("jede einzelne Achse zaehlt", () => {
  for (const patch of [
    { acidity: 2 }, { bitterness: 3 }, { extractionUnder: true },
    { extractionOver: true }, { tasteTags: ["chocolate"] },
  ] as Partial<RatedFields>[]) {
    assert.equal(hasRating({ ...leer, ...patch }), true, JSON.stringify(patch));
  }
});

test("eine leere Aromenliste ist keine Bewertung", () => {
  assert.equal(hasRating({ ...leer, tasteTags: [] }), false);
});

// --- Extraktions-Marken -----------------------------------------------------
// Anlass: die Detailansicht zeigte "ausgewogen" bei einem Bezug, der als
// Channeling markiert war.

test("⚠ Channeling ist eine Extraktions-Marke und verschwindet nicht", () => {
  assert.deepEqual(extractionMarks({ ...leer, channeling: true }), ["channeling"]);
});

test("keine Marke heisst NICHT ausgewogen, sondern leer", () => {
  assert.deepEqual(extractionMarks(leer), []);
  assert.deepEqual(extractionMarks({ ...leer, rating: 4 }), []);
});

test("mehrere Marken stehen nebeneinander, under vor over vor channeling", () => {
  assert.deepEqual(
    extractionMarks({ ...leer, extractionUnder: true, extractionOver: true, channeling: true }),
    ["under", "over", "channeling"],
  );
  assert.deepEqual(
    extractionMarks({ ...leer, extractionUnder: true, channeling: true }),
    ["under", "channeling"],
  );
});
