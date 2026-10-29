/**
 * Bezuege vergleichen: Vorschlag fuer den zweiten Bezug (Flavio 2026-10-20).
 *  - Vorheriger Bezug derselben Sorte (dieselbe Regel wie in der Bewertung).
 *  - Als vollstaendige Historienzeile, damit der Vergleich ohne weiteren
 *    Abruf oeffnen kann.
 *
 * Runner: node:test via tsx — Wegwerf-DB, echte Repos, Routen ueber inject().
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";

process.env.DB_PATH = path.join(os.tmpdir(), `compare-suggestions-${process.pid}-${Date.now()}.db`);

const { initDb, closeDb, getDb } = await import("../src/db/index.js");
const { applySchema } = await import("../src/db/schema.js");
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
const darkBean = bean(dark);
const jamBean = bean(jam);
const steps = { version: 1 as const, steps: [{ kind: "flow" as const, targetFlowGs: 1.4, exit: {} }] };
const gagne = new SqliteProfileRepo().insert({ name: "Adaptive Gagné · 9 bar", scriptIdSingle: null, brewSteps: steps, yieldTargetSingleG: 27 });

let t = now - 1_000_000;
const shot = (beanId: number | null, grind = 20) =>
  id(db.prepare(
    `INSERT INTO shot (profile_id, shot_size, category, started_at, ended_at, bean_id, grind_setting)
     VALUES (?, 'single', 'brew', ?, ?, ?, ?)`,
  ).run(gagne, (t += 60_000), t + 40_000, beanId, grind));
const first = shot(darkBean, 19);
const mid = shot(darkBean, 18.5);
const last = shot(darkBean, 18);
const jamOnly = shot(jamBean);
const noBean = shot(null);

const shots = new SqliteShotRepo();
const app = Fastify({ logger: false });
registerShotRoutes(app, {} as never, shots, {} as never, new SqliteBeanRepo(), new SqliteProfileRepo(), {} as never, () => {}, {} as never, new SqliteSettingsRepo());
type Sugg = { previous: { id: number; grindSetting: number; profileName: string } | null };
const suggest = async (shotId: number) => (await app.inject({ method: "GET", url: `/api/shots/${shotId}/compare-suggestions` })).json() as Sugg;

test("Vorgänger derselben Sorte, als Historienzeile", async () => {
  const s = await suggest(last);
  assert.deepEqual([s.previous?.id, s.previous?.grindSetting, s.previous?.profileName], [mid, 18.5, "Adaptive Gagné · 9 bar"]);
  assert.equal((await suggest(mid)).previous?.id, first);
});

test("Ältester Bezug der Sorte: kein Vorschlag", async () => {
  assert.deepEqual(await suggest(first), { previous: null });
});

test("Andere Sorte und ohne Sorte: nichts", async () => {
  assert.deepEqual(await suggest(jamOnly), { previous: null });
  assert.deepEqual(await suggest(noBean), { previous: null });
});

test("Unbekannter Bezug → 404", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/shots/99999/compare-suggestions" })).statusCode, 404);
});

test("Liste nach ids: leere Liste liefert nichts", () => {
  assert.equal(shots.listShotsFiltered({ ids: [], limit: 5, offset: 0, sort: "date_desc", category: "all" }).shots.length, 0);
  assert.deepEqual(shots.listShotsFiltered({ ids: [last, first], limit: 5, offset: 0, sort: "date_desc", category: "all" }).shots.map((s) => s.id), [last, first]);
});
