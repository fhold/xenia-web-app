/**
 * Profil-Art (Schnitt 3): Bezug oder Wartung steht am Profil statt am Skript.
 *  - Umstellung: Wartung, wo das Skript der ersten Variante Wartung ist; ein
 *    zweiter Start ueberschreibt die Art nicht.
 *  - Aufzeichnung: ein Wartungsprofil erzeugt keinen Bezug, nur den Wartungslauf.
 *  - Route: Art pruefen, Wartung nur mit Skript-Kurven.
 *  - Rueckspuel-Erinnerung: zaehlt Laeufe der gewaehlten Profile; die Skript-
 *    Liste wird einmalig auf Profile umgestellt.
 *  - Versuch (Kolben): Spalte, Anlegen, Umschalten per PUT, nur true/false.
 *
 * Runner: node:test via tsx — Wegwerf-DB.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";

process.env.DB_PATH = path.join(os.tmpdir(), `profile-kind-${process.pid}-${Date.now()}.db`);

const { initDb, closeDb, getDb } = await import("../src/db/index.js");
const { applySchema, adoptProfileKind, migrateBackflushToProfiles } = await import("../src/db/schema.js");
const { SqliteProfileRepo } = await import("../src/db/profile-repo.js");
const { SqliteScriptRepo } = await import("../src/db/script-repo.js");
const { SqliteSettingsRepo } = await import("../src/db/settings-repo.js");
const { SqliteMaintenanceLogRepo } = await import("../src/db/maintenance-repo.js");
const { registerProfileRoutes } = await import("../src/routes/profiles.js");
const { registerMaintenanceRoutes } = await import("../src/routes/maintenance.js");
const { ShotRecorder } = await import("../src/shots/recorder.js");

after(() => {
  closeDb();
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DB_PATH!}${s}`, { force: true });
});

initDb();
applySchema();
const db = getDb();
const now = Date.now();
const profiles = new SqliteProfileRepo();
const script = (id: number, title: string, auto: string, override: string | null = null) =>
  db.prepare("INSERT INTO xenia_script (id, title, content, fetched_at, category_auto, category_override) VALUES (?, ?, '1;13;4 9000 1000;12 20000;7;', ?, ?, ?)")
    .run(id, title, now, auto, override);
script(26, "Cleaning", "maintenance");
script(15, "Spülen", "maintenance");
script(19, "Londinium Single", "brew");
script(40, "Spül-Bezug", "maintenance", "brew");
const base = { isFavorite: false, yieldTargetSingleG: null, yieldTargetDoubleG: null, scriptIdDouble: null };
const backflush = profiles.insert({ ...base, name: "Rückspülen", scriptIdSingle: 26 });
const flush = profiles.insert({ ...base, name: "Flush", scriptIdSingle: 15 });
const londinium = profiles.insert({ ...base, name: "Londinium", scriptIdSingle: 19, yieldTargetSingleG: 25 });
const overridden = profiles.insert({ ...base, name: "Übersteuert", scriptIdSingle: 40 });
const kind = (id: number) => profiles.findById(id)!.kind;

test("Umstellung: Wartung, wo das Skript Wartung ist (Übersteuerung vor Automatik); der nächste Start ändert nichts", () => {
  // frisch angelegt ohne Art: alles Bezug, bis die Umstellung laeuft
  assert.deepEqual([kind(backflush), kind(flush), kind(londinium)], ["brew", "brew", "brew"]);
  adoptProfileKind(db);
  assert.deepEqual([kind(backflush), kind(flush), kind(londinium), kind(overridden)], ["maintenance", "maintenance", "brew", "brew"]);
  // Flavio stellt Flush auf Bezug — ein Neustart darf das nicht zuruecknehmen
  profiles.update(flush, { kind: "brew" });
  applySchema();
  assert.equal(kind(flush), "brew");
  profiles.update(flush, { kind: "maintenance" });
});

test("Wartungsprofile bekommen keine Vorgabe-Siebe", () => {
  const p = profiles.insert({ ...base, name: "Neue Wartung", kind: "maintenance", scriptIdSingle: 15 });
  assert.deepEqual(profiles.findById(p)!.variants!.map((v) => v.defaultBasketId), [null]);
});

test("Aufzeichnung: ein Wartungsprofil erzeugt keinen Bezug, nur den Wartungslauf", () => {
  let created = 0;
  const repo = {
    finalizeAllOpen: () => 0, createShot: () => { created++; return 1; }, appendSample: () => {}, finalizeShot: () => {},
    findById: () => null, logAutoCalibration: () => {}, appendStageTransitions: () => {}, rememberBrewDef: () => "h",
  };
  const noopLog = { child: () => noopLog, info: () => {}, warn: () => {}, error: () => {} };
  const recorder = new ShotRecorder(repo as never, { get: () => null, set: () => {} } as never, {} as never, noopLog as never);
  const runs: [number, number][] = [];
  recorder.on("maintenanceRun", (scriptId: number, profileId: number) => runs.push([scriptId, profileId]));
  const arm = (category: "brew" | "maintenance") => recorder.armForExecute({
    profileId: backflush, profileName: "Rückspülen", scriptId: 26, shotSize: "single", category, hasPumpAction: true,
    hasCmd27: false, cmd27Value: null, yieldTargetG: null, beanId: null, grinderId: null, grindSetting: null, grinderRpm: null, doseG: null, notes: null,
  });
  arm("maintenance");
  recorder.onFrame({ machineStatus: 3, timestamp: Date.now() } as never);
  assert.equal(created, 0);
  assert.deepEqual(runs, [[26, backflush]]);
  recorder.onFrame({ machineStatus: 1, timestamp: Date.now() } as never);
  arm("brew");
  recorder.onFrame({ machineStatus: 3, timestamp: Date.now() } as never);
  assert.equal(created, 1);
});

test("Route: Art wird geprüft, Wartung geht nur mit Skript-Kurven", async () => {
  const app = Fastify();
  registerProfileRoutes(app, profiles, new SqliteScriptRepo(), () => {});
  const steps = { version: 1, steps: [{ kind: "flow", targetFlowGs: 1.4, exit: {} }] };
  const put = (payload: object) => app.inject({ method: "PUT", url: `/api/profiles/${londinium}`, payload });
  assert.equal((await put({ kind: "wartung" })).statusCode, 400);
  const app_ = await put({ kind: "maintenance", variants: [{ name: "Einzel", defaultBasketId: null, yieldG: 25, scriptId: null, brewSteps: steps }] });
  assert.equal(app_.statusCode, 400);
  assert.match((app_.json() as { error: string }).error, /nur mit Skript/);
  const ok = await put({ kind: "maintenance" });
  assert.equal(ok.statusCode, 200);
  assert.equal((ok.json() as { kind: string }).kind, "maintenance");
  assert.equal((await put({ kind: "brew" })).statusCode, 200);
});

test("Versuch: ohne Angabe keiner, PUT schaltet um und nimmt nur true/false, ein Neustart lässt ihn stehen", async () => {
  assert.ok((db.prepare("PRAGMA table_info(profile)").all() as { name: string }[]).some((c) => c.name === "trial"));
  assert.equal(profiles.findById(londinium)!.isTrial, false);
  const app = Fastify();
  registerProfileRoutes(app, profiles, new SqliteScriptRepo(), () => {});
  const put = (payload: object) => app.inject({ method: "PUT", url: `/api/profiles/${londinium}`, payload });
  const on = await put({ isTrial: true });
  assert.equal(on.statusCode, 200);
  assert.equal((on.json() as { isTrial: boolean }).isTrial, true);
  const bad = await put({ isTrial: "ja" });
  assert.equal(bad.statusCode, 400);
  assert.match((bad.json() as { error: string }).error, /isTrial/);
  // Andere Felder lassen den Versuch stehen, ein Neustart auch.
  assert.equal((await put({ notes: "MG 20" })).statusCode, 200);
  applySchema();
  assert.equal(profiles.findById(londinium)!.isTrial, true);
  assert.equal(((await put({ isTrial: false })).json() as { isTrial: boolean }).isTrial, false);
  const probe = profiles.insert({ ...base, name: "Probe", scriptIdSingle: 19, isTrial: true });
  assert.equal(profiles.findById(probe)!.isTrial, true);
});

test("Einordnung: ohne Angabe leer, PUT setzt mehrere, nur dark/light/filter ohne Doppel, ein Neustart lässt sie stehen", async () => {
  assert.ok((db.prepare("PRAGMA table_info(profile)").all() as { name: string }[]).some((c) => c.name === "fit"));
  assert.deepEqual(profiles.findById(londinium)!.fit, []);
  const app = Fastify();
  registerProfileRoutes(app, profiles, new SqliteScriptRepo(), () => {});
  const put = (payload: object) => app.inject({ method: "PUT", url: `/api/profiles/${londinium}`, payload });
  const both = await put({ fit: ["dark", "light"] });
  assert.equal(both.statusCode, 200);
  assert.deepEqual((both.json() as { fit: string[] }).fit, ["dark", "light"]);
  for (const bad of [["medium"], ["dark", "dark"], "dark"]) {
    const r = await put({ fit: bad });
    assert.equal(r.statusCode, 400, JSON.stringify(bad));
    assert.match((r.json() as { error: string }).error, /fit/);
  }
  assert.equal((await put({ notes: "MG 20" })).statusCode, 200);
  applySchema();
  assert.deepEqual(profiles.findById(londinium)!.fit, ["dark", "light"]);
  assert.deepEqual(((await put({ fit: [] })).json() as { fit: string[] }).fit, []);
  const filter = profiles.insert({ ...base, name: "Filterprobe", scriptIdSingle: 19, fit: ["filter"] });
  assert.deepEqual(profiles.findById(filter)!.fit, ["filter"]);
});

test("Archiv: ohne Angabe nicht archiviert, PUT archiviert und stellt wieder her, nur true/false, ein Neustart lässt es stehen", async () => {
  assert.ok((db.prepare("PRAGMA table_info(profile)").all() as { name: string }[]).some((c) => c.name === "archived"));
  assert.equal(profiles.findById(londinium)!.isArchived, false);
  const app = Fastify();
  registerProfileRoutes(app, profiles, new SqliteScriptRepo(), () => {});
  const put = (payload: object) => app.inject({ method: "PUT", url: `/api/profiles/${londinium}`, payload });
  const on = await put({ isArchived: true, isFavorite: false });
  assert.equal(on.statusCode, 200);
  assert.deepEqual([(on.json() as { isArchived: boolean }).isArchived, (on.json() as { isFavorite: boolean }).isFavorite], [true, false]);
  const bad = await put({ isArchived: "ja" });
  assert.equal(bad.statusCode, 400);
  assert.match((bad.json() as { error: string }).error, /isArchived/);
  applySchema();
  assert.equal(profiles.findById(londinium)!.isArchived, true);
  assert.equal(((await put({ isArchived: false })).json() as { isArchived: boolean }).isArchived, false);
});

test("Rückspül-Erinnerung zählt die Läufe der gewählten Profile; die Skriptliste wird einmalig umgestellt", async () => {
  const settings = new SqliteSettingsRepo();
  // Umstellung von Skript 26 auf das Profil, das es faehrt
  db.prepare("DELETE FROM settings WHERE key = 'backflush_profile_ids'").run();
  settings.set("backflush_script_ids", "26");
  migrateBackflushToProfiles(db);
  assert.equal(settings.get("backflush_profile_ids"), String(backflush));
  settings.set("backflush_profile_ids", "");
  migrateBackflushToProfiles(db); // gibt es schon → nichts
  assert.equal(settings.get("backflush_profile_ids"), "");
  settings.set("backflush_profile_ids", String(backflush));

  const log = new SqliteMaintenanceLogRepo();
  log.insert({ scriptId: 26, profileId: backflush, scriptTitle: "Cleaning", ranAt: now - 3_000 });
  log.insert({ scriptId: 15, profileId: flush, scriptTitle: "Spülen", ranAt: now - 1_000 });
  const app = Fastify();
  registerMaintenanceRoutes(app, settings, log);
  const res = (await app.inject({ method: "GET", url: "/api/maintenance/backflush" })).json() as { profileIds: number[]; lastAt: number };
  assert.deepEqual(res.profileIds, [backflush]);
  assert.ok(res.lastAt >= now - 3_000 && res.lastAt < now - 1_000, "Flush zählt nicht als Rückspülen");
});
