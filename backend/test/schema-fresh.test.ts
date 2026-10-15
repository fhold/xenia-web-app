/**
 * Das Schema laesst sich auf einer LEEREN Datenbank aufbauen.
 *
 * Anlass: applySchema() brach auf einer leeren DB ab ("no such column:
 * acidity"). Die Grund-Tabelle `shot` trug profile_id/script_id noch als
 * NOT NULL; das loeste zwei Neuaufbauten mit fester Spaltenliste aus, die
 * schon angelegte Spalten verwarfen. Auf der gewachsenen Live-DB fiel das nie
 * auf — relevant wird es erst bei einer Neuinstallation oder Wiederherstellung.
 * Dass die frisch gebaute DB dieselbe Form hat wie die Live-DB, wurde am
 * 2026-09-26 einmalig per PRAGMA/CHECK-Vergleich gegen eine Kopie geprueft;
 * dieser Test haelt den Aufbau selbst und die Kernspalten fest.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.DB_PATH = path.join(os.tmpdir(), `fresh-schema-${process.pid}-${Date.now()}.db`);

const { initDb, getDb, closeDb } = await import("../src/db/index.js");
const { applySchema } = await import("../src/db/schema.js");

after(() => {
  closeDb();
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DB_PATH!}${s}`, { force: true });
});

const cols = (t: string) =>
  new Map((getDb().prepare(`PRAGMA table_info('${t}')`).all() as { name: string; notnull: number }[])
    .map((c) => [c.name, c.notnull]));

test("⚠ applySchema baut eine leere Datenbank auf, ohne abzubrechen", () => {
  initDb();
  assert.doesNotThrow(() => applySchema());
});

test("ein zweiter Lauf ist ein No-op", () => {
  const before = (getDb().prepare("SELECT sql FROM sqlite_master ORDER BY name").all() as { sql: string | null }[])
    .map((r) => r.sql).join("\n");
  applySchema();
  const again = (getDb().prepare("SELECT sql FROM sqlite_master ORDER BY name").all() as { sql: string | null }[])
    .map((r) => r.sql).join("\n");
  assert.equal(again, before);
});

test("shot hat alle Spalten, die ueber die Jahre dazukamen — keine wurde verworfen", () => {
  const c = cols("shot");
  for (const name of [
    "profile_name", "profile_set_temp_c", "brew_steps", "brew_def_hash", "bean_label",
    "acidity", "bitterness", "extraction_under", "extraction_over",
    "channeling", "channeling_severity", "scale_frozen", "scale_lost", "taste_tags", "grind_note",
  ]) assert.ok(c.has(name), `Spalte fehlt: shot.${name}`);
});

test("profile_id und script_id sind nullbar wie in der Live-DB", () => {
  const c = cols("shot");
  assert.equal(c.get("profile_id"), 0);
  assert.equal(c.get("script_id"), 0);
});

test("stop_mode kennt alle heutigen Werte", () => {
  const sql = (getDb().prepare("SELECT sql FROM sqlite_master WHERE name='shot'").get() as { sql: string }).sql;
  for (const v of ["app_failed", "watchdog", "flowhold", "flowhold_watchdog"]) {
    assert.ok(sql.includes(`'${v}'`), `stop_mode ohne '${v}'`);
  }
});

test("Decaf Flow wird nur auf einer leeren Datenbank angelegt — gelöscht bleibt gelöscht", () => {
  const db = getDb();
  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM profile WHERE name = 'Decaf Flow'").get() as { n: number }).n;
  assert.equal(count(), 1, "frische DB bekommt das Beispielprofil");
  db.prepare("DELETE FROM profile WHERE name = 'Decaf Flow'").run();
  db.prepare("INSERT INTO profile (name) VALUES ('Mein Profil')").run();
  applySchema();
  assert.equal(count(), 0, "nach dem Löschen nicht wieder angelegt");
});
