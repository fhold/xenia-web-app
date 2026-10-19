/**
 * Siebe (vereinter Editor, Schnitt 3b): Ausruestung wie die Muehle — Name frei,
 * Typ Einzel/Doppel/HE. Das Schema legt beim ersten Mal „Einzelsieb“ und
 * „Doppelsieb“ an und danach nie wieder.
 *
 * Runner: node:test via tsx — Wegwerf-DB, Routen ueber fastify.inject().
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";

process.env.DB_PATH = path.join(os.tmpdir(), `baskets-${process.pid}-${Date.now()}.db`);

const { initDb, closeDb, getDb } = await import("../src/db/index.js");
const { applySchema, migrateBasketDetails } = await import("../src/db/schema.js");
const { SqliteBasketRepo } = await import("../src/db/basket-repo.js");
const { registerBasketRoutes } = await import("../src/routes/baskets.js");
const { SqliteProfileRepo } = await import("../src/db/profile-repo.js");

after(() => {
  closeDb();
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DB_PATH!}${s}`, { force: true });
});

initDb();
applySchema();
// Das frische Schema legt Beispiel-Profile an, deren Varianten auf Siebe zeigen — hier zaehlen nur die Siebe.
const profileRepo = new SqliteProfileRepo();
const clearProfiles = () => { for (const p of profileRepo.listAll()) profileRepo.delete(p.id); };
clearProfiles();
const repo = new SqliteBasketRepo();
const app = Fastify();
registerBasketRoutes(app, repo);

test("erstes Schema legt Einzelsieb und Doppelsieb an — ein zweiter Lauf nicht noch einmal", () => {
  assert.deepEqual(repo.listAll().map((s) => [s.name, s.type]), [["Einzelsieb", "single"], ["Doppelsieb", "double"]]);
  applySchema();
  assert.equal(repo.listAll().length, 2);
});

test("auch wenn alle gelöscht sind, kommt die Vorbelegung nicht zurück", () => {
  const before = repo.listAll();
  clearProfiles(); // der Seed legt auf leerer DB wieder ein Beispiel-Profil an, dessen Variante ein Sieb nutzt
  for (const s of before) repo.delete(s.id);
  applySchema();
  assert.equal(repo.listAll().length, 0);
  // fuer die folgenden Tests wieder herstellen
  for (const s of before) repo.insert({ name: s.name, type: s.type });
});

test("anlegen, ändern, löschen — sortiert nach Typ, dann Name", async () => {
  const he = await app.inject({ method: "POST", url: "/api/baskets", payload: { name: "  HE-Sieb  ", type: "he" } });
  assert.equal(he.statusCode, 201);
  const vst = await app.inject({ method: "POST", url: "/api/baskets", payload: { name: "VST 7 g", type: "single" } });
  assert.equal(vst.statusCode, 201);
  const list = (await app.inject({ method: "GET", url: "/api/baskets" })).json() as { name: string; type: string }[];
  assert.deepEqual(list.map((s) => s.name), ["Einzelsieb", "VST 7 g", "Doppelsieb", "HE-Sieb"]);

  const vstId = (vst.json() as { id: number }).id;
  assert.equal((await app.inject({ method: "PUT", url: `/api/baskets/${vstId}`, payload: { name: "VST 18 g", type: "double" } })).statusCode, 200);
  assert.deepEqual([repo.findById(vstId)!.name, repo.findById(vstId)!.type], ["VST 18 g", "double"]);

  assert.equal((await app.inject({ method: "DELETE", url: `/api/baskets/${vstId}` })).statusCode, 200);
  assert.equal(repo.findById(vstId), undefined);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/baskets/${vstId}` })).statusCode, 404);
});

test("ohne Namen oder mit unbekanntem Typ wird nichts gespeichert", async () => {
  const n = repo.listAll().length;
  for (const payload of [{ name: "", type: "single" }, { name: "x".repeat(41), type: "single" }, { name: "Triple", type: "triple" }, { type: "single" }]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/baskets", payload })).statusCode, 400, JSON.stringify(payload));
  }
  const id = repo.listAll()[0]!.id;
  assert.equal((await app.inject({ method: "PUT", url: `/api/baskets/${id}`, payload: { type: "quad" } })).statusCode, 400);
  assert.equal(repo.listAll().length, n);
  // Datenbank laesst einen falschen Typ auch direkt nicht zu
  assert.throws(() => getDb().prepare("INSERT INTO basket (name, type, created_at, updated_at) VALUES ('x', 'quad', 0, 0)").run());
});

test("eine Tabelle aus der kurzen „sieve“-Fassung wird mit ihren Zeilen zu „basket“", () => {
  const db = getDb();
  const rows = repo.listAll().map((b) => [b.id, b.name, b.type]);
  db.exec("ALTER TABLE basket RENAME TO sieve");
  applySchema();
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sieve', 'basket')").all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(tables, ["basket"]);
  assert.deepEqual(repo.listAll().map((b) => [b.id, b.name, b.type]), rows); // nichts verloren, nichts neu angelegt
});


test("Sieb mit Name, Beschreibung und Nenndosis — der Typ ist beim Anlegen optional (intern Einzel)", async () => {
  const res = await app.inject({ method: "POST", url: "/api/baskets", payload: { name: "IMS 3er", description: "  Triple, 21 g, 0,3 mm  ", nominalDoseG: 21 } });
  assert.equal(res.statusCode, 201);
  const id = (res.json() as { id: number }).id;
  const b = repo.findById(id)!;
  assert.deepEqual([b.type, b.description, b.nominalDoseG], ["single", "Triple, 21 g, 0,3 mm", 21]);
  assert.equal(repo.listAll()[0]!.id, id, "Siebe mit Nenndosis stehen vorn");
  assert.equal((await app.inject({ method: "PUT", url: `/api/baskets/${id}`, payload: { description: "  ", nominalDoseG: null } })).statusCode, 200);
  assert.deepEqual([repo.findById(id)!.description, repo.findById(id)!.nominalDoseG], [null, null]);
  for (const payload of [{ description: "x".repeat(201) }, { nominalDoseG: 0 }, { nominalDoseG: 41 }, { nominalDoseG: "21" }]) {
    const r = await app.inject({ method: "PUT", url: `/api/baskets/${id}`, payload });
    assert.equal(r.statusCode, 400, JSON.stringify(payload));
    assert.match((r.json() as { error: string }).error, /Beschreibung|Nenndosis/);
  }
  repo.delete(id);
});

test("Spalten idempotent: ein zweiter Lauf ändert nichts", () => {
  migrateBasketDetails(getDb());
  migrateBasketDetails(getDb());
  const cols = (getDb().prepare("PRAGMA table_info(basket)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("description") && cols.includes("nominal_dose_g"));
});
