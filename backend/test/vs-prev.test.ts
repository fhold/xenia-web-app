/**
 * Vergleich in der Bewertung: besser / gleich / schlechter als der letzte Bezug
 * derselben Sorte (Einstellung rating_compare_prev, Flavio 2026-10-17).
 *  - Der Vergleichsbezug ist der letzte beendete Bezug derselben Sorte VOR dem
 *    bewerteten — auch aus einer anderen Roestung, nie aus einer anderen Sorte,
 *    nie ein laufender oder ein Wartungslauf.
 *  - Ein Urteil wird nur mit seinem Vergleichsbezug gespeichert.
 *
 * Runner: node:test via tsx — Wegwerf-DB, echte Repos, Routen ueber inject().
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";

process.env.DB_PATH = path.join(os.tmpdir(), `vs-prev-${process.pid}-${Date.now()}.db`);

const { initDb, closeDb, getDb } = await import("../src/db/index.js");
const { applySchema, migrateVsPrev } = await import("../src/db/schema.js");
const { SqliteShotRepo } = await import("../src/db/shot-repo.js");
const { SqliteBeanRepo } = await import("../src/db/bean-repo.js");
const { SqliteProfileRepo } = await import("../src/db/profile-repo.js");
const { SqliteSettingsRepo } = await import("../src/db/settings-repo.js");
const { registerShotRoutes } = await import("../src/routes/shots.js");

after(() => {
  closeDb();
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DB_PATH!}${s}`, { force: true });
});

initDb();
applySchema();
const db = getDb();
const now = Date.now();
const id = (r: unknown) => Number((r as { lastInsertRowid: number }).lastInsertRowid);

const coffee = (name: string) => id(db.prepare("INSERT INTO coffee (name, created_at, updated_at) VALUES (?, ?, ?)").run(name, now, now));
const bean = (coffeeId: number) => id(db.prepare("INSERT INTO bean (coffee_id, created_at, updated_at) VALUES (?, ?, ?)").run(coffeeId, now, now));
const dark = coffee("Out of the Dark");
const jam = coffee("The Jam GKC");
const darkAug = bean(dark);
const darkOct = bean(dark);
const jamBean = bean(jam);
const steps = { version: 1 as const, steps: [{ kind: "flow" as const, targetFlowGs: 1.4, exit: {} }] };
const gagne = new SqliteProfileRepo().insert({ name: "Adaptive Gagné · 9 bar", scriptIdSingle: null, brewSteps: steps, yieldTargetSingleG: 27 });

let t = now - 1_000_000;
const shot = (beanId: number | null, opt: { ended?: boolean; category?: string; grind?: number } = {}) =>
  id(db.prepare(
    `INSERT INTO shot (profile_id, shot_size, category, started_at, ended_at, bean_id, grind_setting)
     VALUES (?, 'single', ?, ?, ?, ?, ?)`,
  ).run(gagne, opt.category ?? "brew", (t += 60_000), opt.ended === false ? null : t + 40_000, beanId, opt.grind ?? 20));

const first = shot(darkAug, { grind: 20 });   // aelteste: kein Vorgaenger
const other = shot(jamBean);                   // andere Sorte — zaehlt nie
const second = shot(darkOct, { grind: 19 });  // andere Roestung derselben Sorte → Vorgaenger: first
shot(darkAug, { category: "maintenance" });    // Wartung — zaehlt nie
shot(darkAug, { ended: false });               // laeuft noch — zaehlt nie
const third = shot(darkAug, { grind: 18 });    // → Vorgaenger: second
const noBean = shot(null);                     // ohne Sorte → kein Vergleich

const settings = new SqliteSettingsRepo();
const shots = new SqliteShotRepo();
const app = Fastify({ logger: false });
registerShotRoutes(app, {} as never, shots, {} as never, new SqliteBeanRepo(), new SqliteProfileRepo(), {} as never, {} as never, () => {}, {} as never, settings);
const compare = async (shotId: number) =>
  (await app.inject({ method: "GET", url: `/api/shots/${shotId}/compare` })).json() as { enabled: boolean; previous: { id: number; profileName: string; grindSetting: number } | null };
const put = (shotId: number, payload: object) => app.inject({ method: "PUT", url: `/api/shots/${shotId}`, payload });

test("Vergleichsbezug: letzter beendeter Bezug derselben Sorte davor — andere Röstung ja, andere Sorte, Wartung und laufende nie", async () => {
  assert.equal((await compare(first)).previous, null, "ältester Bezug hat keinen Vorgänger");
  assert.equal((await compare(second)).previous?.id, first, "andere Röstung derselben Sorte zählt, The Jam nicht");
  const c = await compare(third);
  assert.deepEqual([c.previous?.id, c.previous?.profileName, c.previous?.grindSetting], [second, "Adaptive Gagné · 9 bar", 19]);
  assert.equal((await compare(noBean)).previous, null, "ohne Sorte kein Vergleich");
  assert.equal((await compare(other)).previous, null, "The Jam hat davor keinen eigenen Bezug");
});

test("Einstellung: aus, bis sie gesetzt ist", async () => {
  assert.equal((await compare(third)).enabled, false);
  settings.set("rating_compare_prev", "true");
  assert.equal((await compare(third)).enabled, true);
  settings.set("rating_compare_prev", "false");
  assert.equal((await compare(third)).enabled, false);
});

test("Urteil speichern nur mit Vergleichsbezug; null löscht beides", async () => {
  assert.equal((await put(third, { vsPrev: "besser" })).statusCode, 400, "unbekanntes Urteil");
  assert.equal((await put(third, { vsPrev: "better" })).statusCode, 400, "ohne Vergleichsbezug");
  assert.equal((await put(third, { vsPrev: "better", vsPrevShotId: third })).statusCode, 400, "nicht mit sich selbst");
  assert.equal((await put(third, { vsPrev: "better", vsPrevShotId: 99_999 })).statusCode, 400, "unbekannter Bezug");
  assert.equal((await put(third, { vsPrev: "better", vsPrevShotId: second })).statusCode, 200);
  assert.deepEqual([shots.findById(third)!.vsPrev, shots.findById(third)!.vsPrevShotId], ["better", second]);
  const listed = shots.listShotsFiltered({ limit: 50, offset: 0, sort: "date_desc", category: "all" }).shots.find((s) => s.id === third)!;
  assert.deepEqual([listed.vsPrev, listed.vsPrevShotId], ["better", second], "auch in der Historienliste");
  assert.equal((await put(third, { rating: 4 })).statusCode, 200, "andere Felder lassen das Urteil stehen");
  assert.equal(shots.findById(third)!.vsPrev, "better");
  assert.equal((await put(third, { vsPrev: null })).statusCode, 200);
  assert.deepEqual([shots.findById(third)!.vsPrev, shots.findById(third)!.vsPrevShotId], [null, null]);
});

test("Spalten idempotent: ein zweiter Lauf ändert nichts", () => {
  migrateVsPrev(db);
  migrateVsPrev(db);
  const cols = (db.prepare("PRAGMA table_info(shot)").all() as { name: string }[]).map((c) => c.name);
  assert.equal(cols.filter((c) => c === "vs_prev" || c === "vs_prev_shot_id").length, 2);
});
