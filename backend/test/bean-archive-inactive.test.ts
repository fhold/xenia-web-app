/**
 * Archiviert ist nie aktiv — auf beiden Wegen.
 *
 * Der Menüpunkt „Archivieren" (setStatus) nahm das Aktiv-Flag schon mit. Der
 * Bearbeiten-Dialog schickt Status und Aktiv-Haken zusammen (update) und liess
 * „archiviert + aktiv" zu, wenn man den Haken stehen liess.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.DB_PATH = path.join(os.tmpdir(), `bean-archive-${process.pid}-${Date.now()}.db`);

const { initDb, getDb, closeDb } = await import("../src/db/index.js");
const { applySchema } = await import("../src/db/schema.js");
const { SqliteBeanRepo } = await import("../src/db/bean-repo.js");

const repo = new SqliteBeanRepo();

before(() => {
  initDb();
  applySchema();
  getDb().exec("INSERT INTO coffee (id, name, created_at, updated_at) VALUES (1, 'Bergsonne', 0, 0)");
});
after(() => {
  closeDb();
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DB_PATH!}${s}`, { force: true });
});

function activeBean(): number {
  const info = getDb()
    .prepare("INSERT INTO bean (coffee_id, status, is_active, created_at, updated_at) VALUES (1, 'stock', 1, 0, 0)")
    .run();
  return Number(info.lastInsertRowid);
}
const flags = (id: number) => ({
  ...(getDb().prepare("SELECT status, is_active FROM bean WHERE id = ?").get(id) as { status: string; is_active: number }),
});

test("Menü: Archivieren setzt inaktiv", () => {
  const id = activeBean();
  repo.setStatus(id, "archived");
  assert.deepEqual(flags(id), { status: "archived", is_active: 0 });
});

test("⚠ Bearbeiten: archiviert mit stehengelassenem Aktiv-Haken wird trotzdem inaktiv", () => {
  const id = activeBean();
  repo.update(id, { status: "archived", isActive: true });
  assert.deepEqual(flags(id), { status: "archived", is_active: 0 });
});

test("Bearbeiten: archiviert ohne Aktiv-Angabe wird inaktiv", () => {
  const id = activeBean();
  repo.update(id, { status: "archived" });
  assert.deepEqual(flags(id), { status: "archived", is_active: 0 });
});

test("Bearbeiten: andere Status lassen den Haken, wie er gesendet wird", () => {
  const id = activeBean();
  repo.update(id, { status: "frozen", isActive: true });
  assert.deepEqual(flags(id), { status: "frozen", is_active: 1 });
  repo.update(id, { isActive: false });
  assert.deepEqual(flags(id), { status: "frozen", is_active: 0 });
});
