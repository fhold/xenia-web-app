/**
 * Profilliste per Ziehen sortieren: die Reihenfolge gilt jetzt fuer alle
 * Profile, nicht nur fuer Favoriten. Favoriten bleiben trotzdem oben, und ihre
 * Reihenfolge ist die der Dashboard-Chips.
 *
 * Runner: node:test via tsx — Repo gegen eine Wegwerf-DB, Route ueber
 * fastify.inject() mit Fake-Repo.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";

process.env.DB_PATH = path.join(os.tmpdir(), `profile-order-${process.pid}-${Date.now()}.db`);

const { initDb, closeDb } = await import("../src/db/index.js");
const { applySchema } = await import("../src/db/schema.js");
const { SqliteProfileRepo } = await import("../src/db/profile-repo.js");
const { registerProfileRoutes } = await import("../src/routes/profiles.js");

after(() => {
  closeDb();
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DB_PATH!}${s}`, { force: true });
});

initDb();
applySchema();
const repo = new SqliteProfileRepo();
// Das frische Schema legt Beispiel-Profile an — hier zaehlen nur die eigenen.
for (const p of repo.listAll()) repo.delete(p.id);

const make = (name: string, isFavorite: boolean) =>
  repo.insert({ name, scriptIdSingle: null, scriptIdDouble: null, yieldTargetSingleG: null, yieldTargetDoubleG: null, isFavorite });

const fav1 = make("Fav eins", true);
const fav2 = make("Fav zwei", true);
const norm1 = make("Normal eins", false);
const norm2 = make("Normal zwei", false);

const names = () => repo.listAll().map((p) => p.name);

test("Reihenfolge gilt fuer alle Profile, Favoriten bleiben oben", () => {
  // Bewusst ein Nicht-Favorit vorne: die Liste stellt Favoriten trotzdem voran.
  repo.reorder([norm2, fav2, norm1, fav1]);
  assert.deepEqual(names(), ["Fav zwei", "Fav eins", "Normal zwei", "Normal eins"]);
  // Dashboard-Chips = Favoriten in dieser Reihenfolge.
  assert.deepEqual(repo.listFavorites().map((p) => p.name), ["Fav zwei", "Fav eins"]);
});

test("ein neues Profil ohne Platz steht am Ende der Nicht-Favoriten", () => {
  make("Neu", false);
  assert.deepEqual(names(), ["Fav zwei", "Fav eins", "Normal zwei", "Normal eins", "Neu"]);
});

test("Route: /api/profiles/order reicht die Ids durch, falsche Eingaben sind 400", async () => {
  const calls: number[][] = [];
  const app = Fastify({ logger: false });
  registerProfileRoutes(app, { reorder: (ids: number[]) => calls.push(ids) } as never, {} as never, () => {});
  const ok = await app.inject({ method: "POST", url: "/api/profiles/order", payload: { ids: [3, 1, 2] } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(calls, [[3, 1, 2]]);
  const bad = await app.inject({ method: "POST", url: "/api/profiles/order", payload: { ids: [1, "2"] } });
  assert.equal(bad.statusCode, 400);
  assert.equal(calls.length, 1);
});
