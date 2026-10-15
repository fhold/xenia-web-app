/**
 * Profilversion ohne Stufennamen: Umstieg der bestehenden Datenbank.
 *
 * Bis 2026-09-28 floss der Stufenname eines Flow-Profils in `brew_def_hash`.
 * Der neue Hash laesst ihn weg. Ohne Umhaengen der Altbezuege bekaeme der
 * naechste Bezug derselben Fassung einen anderen Hash als seine Vorgaenger —
 * die Geisterwolke risse genau am Umstieg. Das prueft diese Suite: nach der
 * Migration trifft ein neuer Bezug die Altbezuege wieder.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";

process.env.DB_PATH = path.join(os.tmpdir(), `brewdef-test-${process.pid}-${Date.now()}.db`);

const { initDb, getDb, closeDb } = await import("../src/db/index.js");
const { migrateBrewDefCanonical } = await import("../src/db/schema.js");
const { SqliteShotRepo } = await import("../src/db/shot-repo.js");

const repo = new SqliteShotRepo();

/** Der Hash, wie er bis zum Umstieg gebildet wurde: roher JSON-Text samt Namen. */
const oldHash = (kind: string, content: string) =>
  createHash("sha256").update(`${kind}\n${content}`).digest("hex").slice(0, 16);

const steps = (name: string, flow = 1.4) => JSON.stringify({
  version: 1,
  steps: [
    { kind: "power", name: "Füllen", power: 48, rampMs: 6000, exit: { pressureBar: 2 } },
    { kind: "flow", name, targetFlowGs: flow, exit: { weightG: 36 } },
  ],
});

const SCRIPT = "1;13;4 2000 2000;12 10000;7;";

function seedOld(content: string, kind: "steps" | "script", seenAt: number, shots: number): string {
  const h = oldHash(kind, content);
  getDb().prepare("INSERT OR IGNORE INTO brew_def (hash, kind, content, first_seen_at) VALUES (?, ?, ?, ?)")
    .run(h, kind, content, seenAt);
  for (let i = 0; i < shots; i++) {
    getDb().prepare("INSERT INTO shot (started_at, brew_def_hash) VALUES (?, ?)").run(seenAt + i, h);
  }
  return h;
}

const hashesOfShots = () =>
  (getDb().prepare("SELECT brew_def_hash h FROM shot ORDER BY id").all() as { h: string }[]).map((r) => r.h);

before(() => {
  initDb();
  getDb().exec(`
    CREATE TABLE brew_def (hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('script','steps')),
      content TEXT NOT NULL, first_seen_at INTEGER NOT NULL);
    CREATE TABLE shot (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER, brew_def_hash TEXT);
  `);
});
after(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DB_PATH!}${suffix}`, { force: true });
});

test("⚠ Umstieg: zwei nur umbenannte Fassungen werden eine, und ein neuer Bezug trifft sie", () => {
  const a = seedOld(steps("Konstanter Flow"), "steps", 1000, 3);
  const b = seedOld(steps("Extraktion"), "steps", 2000, 2);
  const other = seedOld(steps("Konstanter Flow", 1.6), "steps", 3000, 1);
  const script = seedOld(SCRIPT, "script", 4000, 1);
  assert.equal(new Set([a, b, other]).size, 3, "vorher: drei Fassungen");

  migrateBrewDefCanonical(getDb());

  const hs = hashesOfShots();
  assert.equal(new Set(hs.slice(0, 5)).size, 1, "die fuenf Bezuege der umbenannten Fassungen teilen einen Hash");
  assert.notEqual(hs[5], hs[0], "ein anderer Flow bleibt eine andere Fassung");
  assert.equal(hs[6], script, "Skript-Bezuege bleiben unberuehrt");

  // der naechste Bezug derselben Fassung — mit wieder anderem Namen
  assert.equal(repo.rememberBrewDef("steps", steps("Hauptphase")), hs[0]);

  const defs = getDb().prepare("SELECT hash, first_seen_at FROM brew_def WHERE kind = 'steps' ORDER BY first_seen_at").all() as
    { hash: string; first_seen_at: number }[];
  assert.equal(defs.length, 2, "keine verwaisten Altzeilen");
  assert.equal(defs[0]!.first_seen_at, 1000, "die zusammengelegte Fassung behaelt das frueheste Datum");
  const stored = repo.getBrewDef(hs[0]!)!;
  assert.ok(!stored.content.includes("name"), "gespeichert wird die kanonische Form");
});

test("Umstieg: ein zweiter Lauf aendert nichts", () => {
  const before = hashesOfShots();
  const defsBefore = getDb().prepare("SELECT * FROM brew_def ORDER BY hash").all().map((r) => ({ ...r }));
  migrateBrewDefCanonical(getDb());
  assert.deepEqual(hashesOfShots(), before);
  assert.deepEqual(getDb().prepare("SELECT * FROM brew_def ORDER BY hash").all().map((r) => ({ ...r })), defsBefore);
});
