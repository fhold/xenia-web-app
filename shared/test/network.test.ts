/**
 * Netz Profil ↔ Bohne (Schnitt 4): Gruppen, Zeilen und Reihenfolge aus starken
 * Signalen — rein, ohne DB.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupNetwork, halfStars, type NetShot } from "../src/network.js";

let id = 0;
const shot = (p: Partial<NetShot>): NetShot => ({
  id: ++id, startedAt: id * 1000, profileId: 1, profileName: "Gagne", variantId: 9, basketId: 1, grinderId: 1,
  coffeeId: 5, coffeeName: "Out of the Dark", beanLabel: null, grindSetting: 20, grindNote: null,
  rating: null, acidity: null, bitterness: null, extractionUnder: false, extractionOver: false,
  channeling: false, channelingSeverity: null, tasteTags: null, isBestBrew: false, ...p,
});
const byProfile = (s: NetShot) => ({ key: `p${s.profileId}`, id: s.profileId, label: s.profileName });
const byBasketGrinder = (s: NetShot) => ({ basketId: s.basketId, variantId: null, grinderId: s.grinderId });

test("Zeile: Anzahl, Mahlgrad-Spanne nur mit Mühle, Schnitt nur der bewerteten, zuletzt mit Channeling", () => {
  const g = groupNetwork([
    shot({ grindSetting: 20, rating: 4 }),
    shot({ grindSetting: 18.5, rating: 3, grinderId: null }), // ohne Muehle: eigene Gruppe
    shot({ grindSetting: 21, rating: null, grindNote: "coarser", channeling: true, channelingSeverity: "light" }),
  ], byBasketGrinder, byProfile);
  assert.equal(g.length, 2);
  const r = g[0]!.rows[0]!;
  assert.deepEqual([r.n, r.grindMin, r.grindMax, r.ratingAvg, r.rated], [2, 20, 21, 4, 1]);
  assert.deepEqual([r.last.grind, r.last.note, r.last.channeling], [21, "coarser", "light"]);
});

test("Reihenfolge: Referenz vor Anzahl vor zuletzt — nicht nach Bewertung", () => {
  const g = groupNetwork([
    shot({ profileId: 1, profileName: "A", rating: 5 }),
    shot({ profileId: 2, profileName: "B", rating: 1 }), shot({ profileId: 2, profileName: "B", rating: 1 }),
    shot({ profileId: 3, profileName: "C", isBestBrew: true }),
  ], byBasketGrinder, byProfile);
  assert.deepEqual(g[0]!.rows.map((r) => r.label), ["C", "B", "A"]);
  assert.equal(g[0]!.rows[0]!.reference?.shotId !== undefined, true);
});

test("Channeling unbewertet ist „–“, bewertet ohne Marke „keins“; halbe Punkte", () => {
  const unrated = groupNetwork([shot({})], byBasketGrinder, byProfile)[0]!.rows[0]!;
  const rated = groupNetwork([shot({ grindNote: "ok" })], byBasketGrinder, byProfile)[0]!.rows[0]!;
  assert.equal(unrated.last.channeling, null);
  assert.equal(rated.last.channeling, "none");
  assert.deepEqual([halfStars(4.22), halfStars(3.25), halfStars(3.74)], [4, 3.5, 3.5]);
});
