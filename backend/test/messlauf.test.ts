/**
 * Art „Messlauf“ (Flavio 2026-10-18): ein Lauf, der die Maschine misst, nicht
 * den Kaffee. Er wird aufgezeichnet und ist in der Historie per Filter zu
 * finden, zaehlt aber nirgends sonst.
 *  - Schema: shot.category und profile.kind nehmen 'test' an — frisch, beim
 *    Umbau einer alten DB (Zeilen, Fremdschluessel, Zaehler bleiben) und idempotent.
 *  - Ausschluss: Vorlage fuer Mahlgrad/Dosis, Sorte, gleiche Roestung, Geister,
 *    Netz, Vergleich, letzte Bezuege, Sorten-Vorschlaege, Bestand, Zaehler,
 *    bester Bezug — ueberall nur Bezuege.
 *  - Historie: Standard bleibt Bezug, der Filter „test“ zeigt nur Messlaeufe.
 *  - Aufzeichnung: kein Nachlauf-Lernen aus einem Messlauf.
 *  - Route: Profil-Art 'test' wird angenommen.
 *
 * Runner: node:test via tsx — Wegwerf-DB, echte Repos, Routen ueber inject().
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";

process.env.DB_PATH = path.join(os.tmpdir(), `messlauf-${process.pid}-${Date.now()}.db`);

const { initDb, closeDb, getDb } = await import("../src/db/index.js");
const { applySchema, migrateTestCategory } = await import("../src/db/schema.js");
const { SqliteShotRepo } = await import("../src/db/shot-repo.js");
const { SqliteBeanRepo } = await import("../src/db/bean-repo.js");
const { SqliteCoffeeRepo } = await import("../src/db/coffee-repo.js");
const { SqliteBestBrewRepo } = await import("../src/db/best-brew-repo.js");
const { SqliteProfileRepo } = await import("../src/db/profile-repo.js");
const { SqliteScriptRepo } = await import("../src/db/script-repo.js");
const { SqliteSettingsRepo } = await import("../src/db/settings-repo.js");
const { registerShotRoutes } = await import("../src/routes/shots.js");
const { registerProfileRoutes } = await import("../src/routes/profiles.js");
const { ShotRecorder } = await import("../src/shots/recorder.js");

after(() => {
  closeDb();
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DB_PATH!}${s}`, { force: true });
});

initDb();
applySchema();
const db = getDb();
const now = Date.now();
const id = (r: unknown) => Number((r as { lastInsertRowid: number }).lastInsertRowid);

test("Schema: eine frische DB nimmt Messlauf-Bezüge und -Profile an", () => {
  const sql = (t: string) => (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) as { sql: string }).sql;
  assert.match(sql("shot"), /CHECK\s*\(\s*category IN \('brew','maintenance','test'\)\)/);
  assert.match(sql("profile"), /CHECK\s*\(\s*kind IN \('brew','maintenance','test'\)\)/);
});

test("Schema: Umbau einer alten DB behält Zeilen, Indizes, Zähler und Fremdschlüssel — und ist idempotent", () => {
  const old = new DatabaseSync(":memory:");
  old.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'brew' CHECK(kind IN ('brew','maintenance'))
    );
    CREATE TABLE shot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER REFERENCES profile(id) ON DELETE SET NULL,
      category TEXT NOT NULL CHECK(category IN ('brew','maintenance')),
      started_at INTEGER NOT NULL
    );
    CREATE INDEX idx_shot_started ON shot(started_at);
    CREATE TABLE shot_sample (shot_id INTEGER NOT NULL REFERENCES shot(id) ON DELETE CASCADE, t INTEGER);
    INSERT INTO profile (name, kind) VALUES ('Londinium', 'brew'), ('Rückspülen', 'maintenance');
    INSERT INTO shot (profile_id, category, started_at) VALUES (1, 'brew', 1), (2, 'maintenance', 2), (1, 'brew', 3);
    INSERT INTO shot_sample (shot_id, t) VALUES (1, 0), (3, 0);
    DELETE FROM shot WHERE id = 3;
  `);
  // Zaehler steht auf 3, obwohl die hoechste Zeile 2 ist — darf nicht zurueckfallen.
  migrateTestCategory(old);
  const tableSql = (t: string) => (old.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(t) as { sql: string }).sql;
  assert.match(tableSql("shot"), /'test'/);
  assert.match(tableSql("profile"), /'test'/);
  assert.ok(old.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_shot_started'").get());
  assert.deepEqual(old.prepare("SELECT id, profile_id, category FROM shot ORDER BY id").all().map((r) => ({ ...r })),
    [{ id: 1, profile_id: 1, category: "brew" }, { id: 2, profile_id: 2, category: "maintenance" }]);
  assert.deepEqual({ ...old.prepare("SELECT seq, typeof(seq) AS t FROM sqlite_sequence WHERE name = 'shot'").get() }, { seq: 3, t: "integer" });
  assert.deepEqual(old.prepare("PRAGMA foreign_key_check").all(), []);
  old.prepare("INSERT INTO shot (profile_id, category, started_at) VALUES (1, 'test', 4)").run();
  assert.equal((old.prepare("SELECT MAX(id) AS m FROM shot").get() as { m: number }).m, 4);
  assert.throws(() => old.prepare("INSERT INTO shot (category, started_at) VALUES ('messung', 5)").run(), /CHECK/);
  const before = (old.prepare("SELECT sql FROM sqlite_master ORDER BY name").all() as { sql: string | null }[]).map((r) => r.sql).join("\n");
  migrateTestCategory(old);
  const again = (old.prepare("SELECT sql FROM sqlite_master ORDER BY name").all() as { sql: string | null }[]).map((r) => r.sql).join("\n");
  assert.equal(again, before);
  old.close();
});

// --- Daten: ein Bezug, danach ein Messlauf auf derselben Sorte/Muehle/Sieb ---
const coffeeId = id(db.prepare("INSERT INTO coffee (name, roast_level, created_at, updated_at) VALUES ('Out of the Dark', 'dark', ?, ?)").run(now, now));
const beanId = id(db.prepare("INSERT INTO bean (coffee_id, bag_size_g, created_at, updated_at) VALUES (?, 250, ?, ?)").run(coffeeId, now, now));
const grinderId = id(db.prepare("INSERT INTO grinder (name, created_at, updated_at) VALUES ('DF64', ?, ?)").run(now, now));
const basketId = id(db.prepare("INSERT INTO basket (name, type, created_at, updated_at) VALUES ('Einersieb', 'single', ?, ?)").run(now, now));
const profiles = new SqliteProfileRepo();
const steps = { version: 1 as const, steps: [{ kind: "flow" as const, targetFlowGs: 1.4, exit: {} }] };
const gagne = profiles.insert({ name: "Adaptive Gagné · 9 bar", scriptIdSingle: null, brewSteps: steps, yieldTargetSingleG: 27 });

const shot = (category: string, startedAt: number, label: string, dose: number) => {
  const shotId = id(db.prepare(
    `INSERT INTO shot (profile_id, shot_size, category, started_at, ended_at, bean_id, bean_label, grinder_id, basket_id,
                       grind_setting, dose_g, brew_def_hash)
     VALUES (?, 'single', ?, ?, ?, ?, ?, ?, ?, 20, ?, 'h1')`,
  ).run(gagne, category, startedAt, startedAt + 40_000, beanId, label, grinderId, basketId, dose));
  for (let i = 0; i < 12; i++) db.prepare("INSERT INTO shot_sample (shot_id, elapsed_ms) VALUES (?, ?)").run(shotId, i * 370);
  return shotId;
};
const brew = shot("brew", now - 600_000, "Dark Bezug", 12);
const measure = shot("test", now - 300_000, "Messlauf-Etikett", 99);
const viewer = shot("brew", now - 100_000, "Dark Bezug", 12); // spaeter: Messlauf liegt dazwischen

const shots = new SqliteShotRepo();
const settings = new SqliteSettingsRepo();
const app = Fastify({ logger: false });
registerShotRoutes(app, {} as never, shots, {} as never, new SqliteBeanRepo(), profiles, {} as never, {} as never, () => {}, {} as never, settings);

test("Ausschluss: Vorlagen, Geister, Netz, Vergleich, Vorschläge sehen nur Bezüge", async () => {
  // Fuer die Vorlagen den spaeteren Bezug ausblenden — sonst gewaenne er ohnehin.
  db.prepare("UPDATE shot SET category = 'maintenance' WHERE id = ?").run(viewer);
  assert.equal(shots.findLast({ beanId })?.id, brew);
  assert.equal(shots.findLast({ grinderId, withDose: true })?.id, brew);
  assert.equal(shots.findLastByCoffee({ coffeeId, withDose: true })?.id, brew);
  assert.equal(shots.findLastSameRoast({ beanId, profileId: gagne, basketId, grinderId })?.id, brew);
  db.prepare("UPDATE shot SET category = 'brew' WHERE id = ?").run(viewer);

  const ghosts = shots.listGhostCandidates({ excludeShotId: viewer, basis: "brewdef", key: "h1", minSamples: 10, limit: 10, basketId, shotSize: "single" });
  assert.deepEqual(ghosts, [brew]);
  assert.deepEqual(shots.listNetworkShots({ coffeeId }).map((s) => s.id), [brew, viewer]);
  assert.deepEqual(shots.listNetworkShots({ profileId: gagne }).map((s) => s.id), [brew, viewer]);
  assert.deepEqual(shots.listRecentBrew(10).map((s) => s.id), [viewer, brew]);
  assert.equal(shots.findPreviousSameCoffee(viewer)?.id, brew);
  assert.deepEqual(shots.beanLabelSuggestions().map((s) => s.label), ["Dark Bezug"]);
});

test("Ausschluss: Bestand, Zähler und letzter Bezug der Sorte zählen den Messlauf nicht", () => {
  const b = new SqliteBeanRepo().findById(beanId)!;
  assert.equal(b.shotCount, 2);
  assert.equal(b.remainingG, 250 - 24, "99 g Messlauf-Dosis darf den Bestand nicht mindern");
  const c = new SqliteCoffeeRepo().listAll().find((x) => x.id === coffeeId)!;
  assert.equal(c.shotCount, 2);
  // Loeschschutz zaehlt bewusst alles — sonst verschwaende die Historie mit der Sorte.
  assert.equal(new SqliteCoffeeRepo().shotCount(coffeeId), 3);
});

test("Ausschluss: ein Messlauf kann nicht bester Bezug werden", () => {
  const r = new SqliteBestBrewRepo().setByShot(measure);
  assert.equal(r.ok, false);
});

test("Historie: Standard bleibt Bezug, der Filter „test“ zeigt nur Messläufe", async () => {
  const list = async (q: string) =>
    ((await app.inject({ method: "GET", url: `/api/shots${q}` })).json() as { shots: { id: number }[] }).shots.map((s) => s.id);
  assert.deepEqual((await list("")).sort(), [brew, viewer].sort());
  assert.deepEqual(await list("?category=test"), [measure]);
  assert.equal((await list("?category=all")).length, 3);
});

test("Route: Profil-Art Messlauf wird angenommen, Unbekanntes nicht", async () => {
  const r = Fastify();
  registerProfileRoutes(r, profiles, new SqliteScriptRepo(), () => {});
  const put = (payload: object) => r.inject({ method: "PUT", url: `/api/profiles/${gagne}`, payload });
  const ok = await put({ kind: "test" });
  assert.equal(ok.statusCode, 200);
  assert.equal((ok.json() as { kind: string }).kind, "test");
  assert.equal(profiles.findById(gagne)!.kind, "test");
  assert.equal((await put({ kind: "messlauf" })).statusCode, 400);
  assert.equal((await put({ kind: "brew" })).statusCode, 200);
});

test("Aufzeichnung: ein App-Stopp im Messlauf lernt keinen Nachlauf, im Bezug schon", () => {
  const noopLog = { child: () => noopLog, info: () => {}, warn: () => {}, error: () => {} };
  const run = (category: "brew" | "test") => {
    let clock = 0;
    const realNow = Date.now;
    Date.now = () => clock;
    try {
      const repo = {
        finalizeAllOpen: () => 0, createShot: () => 1, appendSample: () => {}, finalizeShot: () => {},
        findById: () => ({ id: 1 }), logAutoCalibration: () => {}, appendStageTransitions: () => {}, rememberBrewDef: () => "h",
      };
      const recorder = new ShotRecorder(repo as never, { get: () => null, set: () => {} } as never, {} as never, noopLog as never);
      let calibrations = 0;
      (recorder as unknown as { autoCalibrateBbwLag: () => void }).autoCalibrateBbwLag = () => { calibrations++; };
      recorder.armForDrive({
        profileId: gagne, profileName: "Messung", scriptId: null as never, shotSize: "single", category, hasPumpAction: true,
        hasCmd27: false, cmd27Value: null, yieldTargetG: 27, beanId: null, grinderId: null, grindSetting: null, grinderRpm: null, doseG: null, notes: null,
      });
      const frame = (machineStatus: number, w: number) => ({ machineStatus, machineState: machineStatus === 5 ? "brewing" : "off", scaleWeightG: w, timestamp: clock }) as never;
      clock = 100; recorder.onFrame(frame(5, 0));
      clock = 1000; recorder.onFrame(frame(5, 20));
      recorder.setDriveStopMode("app");
      clock = 1100; recorder.onFrame(frame(0, 27));
      clock = 2300; recorder.onFrame(frame(0, 27));
      return calibrations;
    } finally {
      Date.now = realNow;
    }
  };
  assert.equal(run("brew"), 1);
  assert.equal(run("test"), 0);
});
