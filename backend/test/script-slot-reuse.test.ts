/**
 * Ein freigewordener Skript-Platz, den die Maschine neu belegt, ist ein neues
 * Skript — es darf die von Hand gesetzte Kategorie des alten nicht erben.
 * Anlass: „80s Decent PI“ landete auf Platz 11, wo früher das gelöschte
 * „befehltest“ mit Kategorie „Wartung“ stand; das neue Brüh-Skript erschien als
 * Wartung und wäre auch so gestartet worden (keine Aufzeichnung, kein BBW).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.DB_PATH = path.join(os.tmpdir(), `slot-reuse-${process.pid}-${Date.now()}.db`);

const { initDb, closeDb } = await import("../src/db/index.js");
const { applySchema } = await import("../src/db/schema.js");
const { SqliteScriptRepo } = await import("../src/db/script-repo.js");

after(() => {
  closeDb();
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DB_PATH!}${s}`, { force: true });
});

initDb();
applySchema();
const repo = new SqliteScriptRepo();

const script = (id: number, title: string, content: string) => ({
  id, title, content, parsedCmds: null, hasCmd27: false, cmd27Value: null,
  categoryAuto: "brew" as const, categoryOverride: null, fetchedAt: Date.now(), orphanedAt: null,
});

test("neues Skript auf einem verwaisten Platz: alte manuelle Kategorie verfällt (Voll-Abgleich)", () => {
  repo.upsert(script(11, "befehltest", "1;12 1000;13;4 2000 10000;27 20;17;7;"));
  repo.setCategoryOverride(11, "maintenance");
  repo.markOrphaned(11, Date.now());
  repo.upsert(script(11, "80s Decent PI", "1;13;4 3800 2000;26 3800;12 3000;17;7;"));
  assert.equal(repo.findById(11)!.categoryOverride, null);
});

test("neues Skript auf einem verwaisten Platz: auch über den Titel-Abgleich", () => {
  repo.upsert(script(12, "alt", "1;13;4 9000 5000;12 45000;17;7;"));
  repo.setCategoryOverride(12, "maintenance");
  repo.markOrphaned(12, Date.now());
  repo.updateTitle(12, "neu");
  assert.equal(repo.findById(12)!.categoryOverride, null);
  assert.equal(repo.findById(12)!.orphanedAt, null);
});

test("bestehendes Skript: Abgleich und Umbenennen lassen die manuelle Kategorie stehen", () => {
  repo.upsert(script(13, "Cleaning", "1;13;4 9000 1000;12 20000;17;7;"));
  repo.setCategoryOverride(13, "maintenance");
  repo.upsert(script(13, "Cleaning", "1;13;4 9000 1000;12 20000;17;7;"));
  repo.updateTitle(13, "Cleaning neu");
  assert.equal(repo.findById(13)!.categoryOverride, "maintenance");
});
