/**
 * Profil als Datei (2026-10-20): Export, Lesen von v1–v3 und der Import-Plan
 * (Skript wiederverwenden / anlegen / fragen, Sieb per Name, Name mit Zaehler).
 * Runner: node:test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProfileFile, canonicalScript, planProfileImport, profileFileName, readProfileFile, uniqueProfileName,
  PROFILE_FILE_VERSION, type ProfileFileProfile,
} from "../src/profile-file.js";
import type { Basket, BrewProfile, Profile, ProfileVariant, XeniaScript } from "../src/types.js";

const GAGNE: BrewProfile = {
  version: 1,
  steps: [
    { kind: "preinfusion", name: "Füllen", gentleness: "normal", exit: { pressureBar: 4, seconds: 25 } },
    { kind: "pressure", name: "Druckspitze", targetPressureBar: 9, rampMs: 3000, exit: { seconds: 7 } },
    { kind: "flow", name: "Fluss halten", targetFlowGs: 1.5, adoptFlow: true, maxPressureBar: 9.5, exit: {} },
  ],
} as BrewProfile;

const LONDINIUM = "1;13;4 2000 2000;12 10000;6;12 12000;4 6000 2000;12 60000;7;";

const basket = (id: number, name: string, extra: Partial<Basket> = {}): Basket =>
  ({ id, name, type: "single", description: null, nominalDoseG: null, createdAt: 0, updatedAt: 0, ...extra });
const script = (id: number, title: string, content: string, orphanedAt: number | null = null): XeniaScript =>
  ({ id, title, content, parsedCmds: null, hasCmd27: false, cmd27Value: null, categoryAuto: "brew", orphanedAt } as unknown as XeniaScript);
const variant = (v: Partial<ProfileVariant> & { id: number; name: string }): ProfileVariant => ({
  sortOrder: v.id, defaultBasketId: null, yieldG: null, scriptId: null, brewSteps: null, sameAsId: null, phaseNames: null, legacySlot: null, ...v,
});
const profile = (variants: ProfileVariant[], extra: Partial<Profile> = {}): Profile => ({
  id: 22, name: "Adaptive Gagné · 9 bar", description: null, kind: "brew", isTrial: true, fit: ["dark", "light"],
  scriptIdSingle: null, scriptIdDouble: null, yieldTargetSingleG: 27, yieldTargetDoubleG: null,
  isFavorite: true, favoriteOrder: 3, notes: "MG 19,5", targetTempC: 88, brewSteps: GAGNE, brewStepsDouble: null,
  variants, ...extra,
});

const BASKETS = [basket(1, "Einersieb Xenia"), basket(5, "Step-Down", { description: "Stufensieb, optimal 15 g", nominalDoseG: 15 })];

test("Export: Varianten mit Sieb (Name, Beschreibung, Nenndosis), „wie“ per Name, Skript mit Text — keine IDs, keine Favoriten", () => {
  const p = profile([
    variant({ id: 7, name: "Einzel", defaultBasketId: 1, yieldG: 27, brewSteps: GAGNE }),
    variant({ id: 9, name: "Step-Down", defaultBasketId: 5, yieldG: 27, sameAsId: 7 }),
  ]);
  const file = buildProfileFile(p, [], BASKETS);
  assert.equal(file.kind, "xenia-profile");
  assert.equal(file.version, PROFILE_FILE_VERSION);
  assert.deepEqual(file.profile.variants[1], {
    name: "Step-Down", basket: { name: "Step-Down", description: "Stufensieb, optimal 15 g", nominalDoseG: 15 },
    yieldG: 27, sameAs: "Einzel", script: null, phaseNames: null, brewSteps: null,
  });
  const text = JSON.stringify(file);
  for (const key of ["isFavorite", "favoriteOrder", "\"id\"", "defaultBasketId", "scriptId", "sameAsId"]) {
    assert.ok(!text.includes(key), `${key} gehört nicht in die Datei`);
  }

  const withScript = profile([variant({ id: 1, name: "Einzel", yieldG: 36, scriptId: 19, phaseNames: ["Preinfusion", null] })], { brewSteps: null });
  const f2 = buildProfileFile(withScript, [script(19, "Londinium Single", LONDINIUM)], BASKETS);
  assert.deepEqual(f2.profile.variants[0]!.script, { title: "Londinium Single", content: LONDINIUM });
  assert.deepEqual(f2.profile.variants[0]!.phaseNames, ["Preinfusion", null]);
});

test("Export → Lesen ergibt dasselbe Profil (auch über JSON)", () => {
  const p = profile([
    variant({ id: 7, name: "Einzel", defaultBasketId: 1, yieldG: 27, brewSteps: GAGNE }),
    variant({ id: 9, name: "Step-Down", defaultBasketId: 5, yieldG: 27, sameAsId: 7 }),
  ]);
  const file = buildProfileFile(p, [], BASKETS);
  const read = readProfileFile(JSON.parse(JSON.stringify(file)));
  assert.ok(read.ok);
  assert.deepEqual(read.profile, file.profile);
});

test("Dateiname aus dem Profilnamen", () => {
  assert.equal(profileFileName("Adaptive Gagné · 9 bar"), "adaptive-gagné-9-bar.xenia-profile.json");
  assert.equal(profileFileName("···"), "profil.xenia-profile.json");
});

test("Lesen v2: Sieb mit Name + Typ — Typ fällt weg, Beschreibung/Nenndosis leer", () => {
  const read = readProfileFile({
    kind: "xenia-profile", version: 2,
    profile: { name: "80s Decent", kind: "brew", isTrial: false, targetTempC: 80, notes: null, variants: [
      { name: "Einzel", basket: { name: "Einersieb Xenia", type: "single" }, yieldG: 20, sameAs: null,
        script: { title: "80s Decent", content: LONDINIUM }, phaseNames: null, brewSteps: null },
    ] },
  });
  assert.ok(read.ok);
  assert.deepEqual(read.profile.variants[0]!.basket, { name: "Einersieb Xenia", description: null, nominalDoseG: null });
});

test("Lesen v1: App-Profil → Einzel, Doppel „wie Einzel“ ohne eigene 2×-Stufen", () => {
  const read = readProfileFile({
    kind: "xenia-profile", version: 1,
    profile: { name: "Decaf Flow (PI)", scriptIdSingle: null, scriptIdDouble: null, yieldTargetSingleG: 30, yieldTargetDoubleG: 45,
      targetTempC: 93, notes: null, brewSteps: GAGNE, brewStepsDouble: null },
  });
  assert.ok(read.ok);
  assert.equal(read.profile.kind, "brew");
  assert.equal(read.profile.isTrial, false);
  assert.deepEqual(read.profile.variants.map((v) => [v.name, v.yieldG, v.sameAs, v.brewSteps !== null]), [
    ["Einzel", 30, null, true],
    ["Doppel", 45, "Einzel", false],
  ]);
});

test("Lesen v1: Skript-Profil wird abgelehnt — die Datei kennt nur die Nummer", () => {
  const read = readProfileFile({
    kind: "xenia-profile", version: 1,
    profile: { name: "Londinium", scriptIdSingle: 19, yieldTargetSingleG: 36, brewSteps: null },
  });
  assert.equal(read.ok, false);
  assert.match((read as { error: string }).error, /nur die Nummer.*neu exportieren/);
});

test("Lesen: fremde Datei, neuere Version, fehlender Name, Unsinn in Feldern", () => {
  const err = (raw: unknown) => { const r = readProfileFile(raw); assert.equal(r.ok, false); return (r as { error: string }).error; };
  assert.match(err({ hello: "world" }), /keine Profil-Datei/);
  assert.match(err(null), /keine Profil-Datei/);
  assert.match(err({ kind: "xenia-profile", version: 9, profile: {} }), /neueren App.*v9/);
  assert.match(err({ kind: "xenia-profile", version: 3, profile: { name: " ", variants: [] } }), /keinen Namen/);
  assert.match(err({ kind: "xenia-profile", version: 3, profile: { name: "X", variants: [] } }), /keine Varianten/);
  assert.match(err({ kind: "xenia-profile", version: 3, profile: { name: "X", kind: "party", variants: [{ name: "A" }] } }), /Art/);
  assert.match(err({ kind: "xenia-profile", version: 3, profile: { name: "X", variants: [{ name: "A", yieldG: "viel" }] } }), /ungültige Angaben/);
  assert.match(err({ kind: "xenia-profile", version: 3, profile: { name: "X", variants: [{ name: "A", script: { title: "S" } }] } }), /Skript ungültig/);
});

// --- Import-Plan ---------------------------------------------------------------

const fileProfile = (variants: ProfileFileProfile["variants"]): ProfileFileProfile =>
  ({ name: "Londinium", kind: "brew", isTrial: false, targetTempC: 92, notes: null, variants });
const sv = (name: string, title: string, content: string, basketName: string | null = null) =>
  ({ name, basket: basketName ? { name: basketName, description: null, nominalDoseG: null } : null, yieldG: 36, sameAs: null,
    script: { title, content }, phaseNames: null, brewSteps: null });

test("Plan: identischer Skripttext → verwenden, auch unter anderem Titel; fehlt er → anlegen", () => {
  const plan = planProfileImport(
    fileProfile([sv("Einzel", "Londinium Single", LONDINIUM), sv("Doppel", "Londinium Double", "1;13;4 9000 1000;12 30000;7;")]),
    { scripts: [script(31, "Mein Londinium", LONDINIUM)], baskets: [], profileNames: [] },
  );
  assert.deepEqual(plan.variants[0]!.script, { status: "same", title: "Mein Londinium", scriptId: 31 });
  assert.deepEqual(plan.variants[1]!.script, { status: "new", title: "Londinium Double" });
  assert.equal(plan.variants[0]!.curve, "script");
});

test("Plan: gleicher Titel mit anderem Text → Konflikt (der Nutzer entscheidet)", () => {
  const plan = planProfileImport(
    fileProfile([sv("Einzel", "Londinium Single", LONDINIUM)]),
    { scripts: [script(19, "Londinium Single", "1;13;4 8000 1000;12 25000;7;")], baskets: [], profileNames: [] },
  );
  assert.deepEqual(plan.variants[0]!.script, { status: "conflict", title: "Londinium Single", scriptId: 19 });
});

test("Plan: verwaiste Skripte (nicht mehr auf der Maschine) zählen nicht", () => {
  const plan = planProfileImport(
    fileProfile([sv("Einzel", "Londinium Single", LONDINIUM)]),
    { scripts: [script(19, "Londinium Single", LONDINIUM, 1_700_000_000_000)], baskets: [], profileNames: [] },
  );
  assert.equal(plan.variants[0]!.script!.status, "new");
});

test("Plan: Sieb per Name (Groß/Klein egal), fehlendes Sieb wird gemeldet", () => {
  const plan = planProfileImport(
    fileProfile([sv("Einzel", "A", LONDINIUM, "step-down"), sv("Doppel", "B", LONDINIUM, "VST 18 g")]),
    { scripts: [], baskets: BASKETS, profileNames: [] },
  );
  assert.deepEqual(plan.variants.map((v) => [v.basketId, v.missingBasket]), [[5, null], [null, "VST 18 g"]]);
});

test("Plan: vorhandener Name bekommt einen Zähler, nie überschreiben", () => {
  assert.equal(uniqueProfileName("Londinium", ["Decaf"]), "Londinium");
  assert.equal(uniqueProfileName("Londinium", ["londinium", "Londinium (2)"]), "Londinium (3)");
  const plan = planProfileImport(fileProfile([sv("Einzel", "A", LONDINIUM)]), { scripts: [], baskets: [], profileNames: ["Londinium"] });
  assert.equal(plan.name, "Londinium (2)");
  assert.equal(plan.renamed, true);
});

test("Skripttext vergleicht in kanonischer Form", () => {
  assert.equal(canonicalScript(LONDINIUM), canonicalScript(` ${LONDINIUM} `));
});
