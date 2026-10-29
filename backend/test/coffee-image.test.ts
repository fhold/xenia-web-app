/**
 * Sorten-Foto — Magic-Byte-Erkennung und Ablage.
 *
 * Zwei Haelften: der reine Sniffer (kein I/O) und die Ablage in einer
 * Wegwerf-DB. Bei der Ablage interessieren drei Dinge, die man sonst erst in
 * Produktion merkt: dass ein zweites Bild das erste ERSETZT (ein Foto je
 * Sorte), dass es mit der Sorte verschwindet statt als Waise liegenzubleiben,
 * und dass die Listen-Query den Zeitstempel liefert, ohne den BLOB
 * mitzuschleppen.
 */

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { sniffImageMime, MAX_IMAGE_BYTES } from "../../shared/src/image-mime.js";

process.env.DB_PATH = path.join(os.tmpdir(), `img-test-${process.pid}-${Date.now()}.db`);

const { initDb, getDb, closeDb } = await import("../src/db/index.js");
const { SqliteCoffeeRepo } = await import("../src/db/coffee-repo.js");

const repo = new SqliteCoffeeRepo();

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBP", "latin1"), Buffer.alloc(4),
]);

// ---------------------------------------------------------------------------
// Sniffer
// ---------------------------------------------------------------------------

test("erkennt JPEG, PNG und WebP an den Magic Bytes", () => {
  assert.equal(sniffImageMime(JPEG), "image/jpeg");
  assert.equal(sniffImageMime(PNG), "image/png");
  assert.equal(sniffImageMime(WEBP), "image/webp");
});

test("alles andere wird abgelehnt, auch wenn es sich Bild nennt", () => {
  assert.equal(sniffImageMime(Buffer.from("GIF89a und dann noch was", "latin1")), null);
  assert.equal(sniffImageMime(Buffer.from("<?php echo 1; ?>", "latin1")), null);
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8])), null); // JPEG-Anfang, zu kurz
  assert.equal(sniffImageMime(Buffer.alloc(0)), null);
});

test("RIFF allein reicht nicht — der WEBP-Tag muss sitzen", () => {
  const wav = Buffer.concat([
    Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WAVE", "latin1"), Buffer.alloc(4),
  ]);
  assert.equal(sniffImageMime(wav), null);
});

test("die Obergrenze passt unter das 2-MB-Body-Limit, auch als Base64", () => {
  assert.ok(MAX_IMAGE_BYTES * 4 / 3 < 2_000_000);
});

// ---------------------------------------------------------------------------
// Ablage
// ---------------------------------------------------------------------------

function createSchema(): void {
  getDb().exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE coffee (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, roaster TEXT,
      country TEXT, region TEXT, farm TEXT, variety TEXT, processing TEXT,
      altitude_min INTEGER, altitude_max INTEGER, roast_level TEXT, brew_type TEXT,
      flavor_notes TEXT, notes TEXT, favourite INTEGER NOT NULL DEFAULT 0,
      rating TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE bean (id INTEGER PRIMARY KEY AUTOINCREMENT,
      coffee_id INTEGER NOT NULL REFERENCES coffee(id) ON DELETE RESTRICT);
    CREATE TABLE shot (id INTEGER PRIMARY KEY AUTOINCREMENT,
      bean_id INTEGER REFERENCES bean(id) ON DELETE SET NULL, started_at INTEGER, category TEXT);
    CREATE TABLE coffee_image (
      coffee_id  INTEGER PRIMARY KEY REFERENCES coffee(id) ON DELETE CASCADE,
      mime       TEXT NOT NULL,
      bytes      BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function addCoffee(name: string): number {
  const now = Date.now();
  const info = getDb()
    .prepare("INSERT INTO coffee (name, favourite, created_at, updated_at) VALUES (?, 0, ?, ?)")
    .run(name, now, now);
  return Number(info.lastInsertRowid);
}

before(() => { initDb(process.env.DB_PATH!); createSchema(); });
// In Abhaengigkeitsreihenfolge: bean referenziert coffee mit RESTRICT.
beforeEach(() => { getDb().exec("DELETE FROM shot; DELETE FROM bean; DELETE FROM coffee_image; DELETE FROM coffee;"); });
after(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${process.env.DB_PATH!}${suffix}`, { force: true });
  }
});

test("Bild kommt unveraendert zurueck", () => {
  const id = addCoffee("Deepwood");
  repo.putImage(id, "image/jpeg", JPEG);
  const got = repo.getImage(id)!;
  assert.equal(got.mime, "image/jpeg");
  assert.ok(Buffer.from(got.bytes).equals(JPEG));
  assert.ok(got.updatedAt > 0);
});

test("ein zweites Bild ersetzt das erste — eines je Sorte", () => {
  const id = addCoffee("Crema Bar");
  repo.putImage(id, "image/jpeg", JPEG);
  repo.putImage(id, "image/png", PNG);
  assert.equal(repo.getImage(id)!.mime, "image/png");
  const n = getDb().prepare("SELECT COUNT(*) c FROM coffee_image WHERE coffee_id = ?").get(id) as { c: number };
  assert.equal(n.c, 1);
});

test("ohne Bild kommt undefined, nicht ein leerer Datensatz", () => {
  assert.equal(repo.getImage(addCoffee("Martella")), undefined);
});

test("Loeschen meldet, ob es etwas zu loeschen gab", () => {
  const id = addCoffee("Testbohne");
  assert.equal(repo.deleteImage(id), false);
  repo.putImage(id, "image/jpeg", JPEG);
  assert.equal(repo.deleteImage(id), true);
  assert.equal(repo.getImage(id), undefined);
});

test("mit der Sorte verschwindet das Bild, keine Waise", () => {
  const id = addCoffee("Weg damit");
  repo.putImage(id, "image/jpeg", JPEG);
  getDb().prepare("DELETE FROM coffee WHERE id = ?").run(id);
  const n = getDb().prepare("SELECT COUNT(*) c FROM coffee_image").get() as { c: number };
  assert.equal(n.c, 0);
});

test("die Listen-Query liefert den Zeitstempel, nicht den BLOB", () => {
  const withImg = addCoffee("Mit Bild");
  const without = addCoffee("Ohne Bild");
  repo.putImage(withImg, "image/jpeg", JPEG);
  const list = repo.listAll();
  const a = list.find((c) => c.id === withImg)!;
  const b = list.find((c) => c.id === without)!;
  assert.ok(a.imageUpdatedAt && a.imageUpdatedAt > 0);
  assert.equal(b.imageUpdatedAt, null);
  assert.ok(!("bytes" in (a as Record<string, unknown>)));
});

// ---------------------------------------------------------------------------
// Löschen mit Röstungen — erlaubt, solange kein Bezug daran hängt
// ---------------------------------------------------------------------------

function addBean(coffeeId: number): number {
  const info = getDb().prepare("INSERT INTO bean (coffee_id) VALUES (?)").run(coffeeId);
  return Number(info.lastInsertRowid);
}
function addShot(beanId: number): void {
  getDb().prepare("INSERT INTO shot (bean_id, started_at, category) VALUES (?, 0, 'brew')").run(beanId);
}

test("Sorte mit Röstungen, aber ohne Bezüge: Röstungen gehen mit", () => {
  const id = addCoffee("Wegwerf");
  addBean(id); addBean(id);
  assert.equal(repo.shotCount(id), 0);
  repo.deleteWithRoastings(id);
  assert.equal(repo.findById(id), undefined);
  const rest = getDb().prepare("SELECT COUNT(*) c FROM bean WHERE coffee_id = ?").get(id) as { c: number };
  assert.equal(rest.c, 0);
});

test("hängt ein Bezug daran, wird nichts gelöscht", () => {
  const id = addCoffee("Mit Historie");
  const b = addBean(id);
  addShot(b);
  assert.equal(repo.shotCount(id), 1);
  assert.throws(() => { repo.deleteWithRoastings(id); }, /Bezüge/);
  // ⚠ Der Punkt des Tests: nach dem Abbruch steht ALLES noch, nicht nur die Sorte.
  assert.ok(repo.findById(id));
  const rest = getDb().prepare("SELECT COUNT(*) c FROM bean WHERE coffee_id = ?").get(id) as { c: number };
  assert.equal(rest.c, 1);
});

test("shotCount zählt nur die Bezüge dieser Sorte", () => {
  const a = addCoffee("A"); const bb = addCoffee("B");
  addShot(addBean(a)); addShot(addBean(a)); addBean(bb);
  assert.equal(repo.shotCount(a), 2);
  assert.equal(repo.shotCount(bb), 0);
});

test("die strenge delete() bleibt streng — sie ist der Weg ohne Röstungen", () => {
  const id = addCoffee("Leer");
  repo.delete(id);
  assert.equal(repo.findById(id), undefined);
  const id2 = addCoffee("Voll");
  addBean(id2);
  assert.throws(() => { repo.delete(id2); }, /Röstungen/);
});

// ---------------------------------------------------------------------------
// Freitext-Bohne (Fremdbohne) — Vorschlagsliste
// ---------------------------------------------------------------------------

test("Vorschläge: zuletzt benutzte zuerst, mit Anzahl", async () => {
  const { SqliteShotRepo } = await import("../src/db/shot-repo.js");
  const shots = new SqliteShotRepo();
  const db = getDb();
  db.exec("ALTER TABLE shot ADD COLUMN bean_label TEXT");
  const ins = db.prepare("INSERT INTO shot (bean_id, bean_label, started_at, category) VALUES (NULL, ?, ?, 'brew')");
  ins.run("Gatuya", 1000);
  ins.run("Momo", 2000);
  ins.run("gatuya", 3000);          // andere Schreibweise, gleiche Bohne
  ins.run(null, 4000);              // ohne Bohne — taucht nicht auf
  ins.run("   ", 5000);             // leer getippt — taucht nicht auf
  const s = shots.beanLabelSuggestions();
  assert.deepEqual(s.map((x) => x.label), ["gatuya", "Momo"]);
  // ⚠ Der Punkt: "Gatuya" und "gatuya" sind EIN Vorschlag, sonst zerfaellt
  // genau die Gruppierung, wegen der es das Feld gibt.
  assert.equal(s[0]!.count, 2);
  assert.equal(s[1]!.count, 1);
  assert.ok(s[0]!.lastUsedAt > s[1]!.lastUsedAt);
});
