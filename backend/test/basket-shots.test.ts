/**
 * Schnitt 3e: das Sieb in Historie und Start-Dialog.
 *  - Mahlgrad zuerst nach Bohne + Muehle + Profil + Sieb, Dosis zuerst nach
 *    Bohne + Sieb; `grindSource` nennt Stufe und Quellbezug.
 *  - Historie nach Sieb filtern; das Sieb eines Bezugs korrigieren, shot_size
 *    folgt dem Siebtyp.
 *
 * Runner: node:test via tsx — Wegwerf-DB, echte Repos, Routen ueber inject().
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";

process.env.DB_PATH = path.join(os.tmpdir(), `basket-shots-${process.pid}-${Date.now()}.db`);

const { initDb, closeDb, getDb } = await import("../src/db/index.js");
const { applySchema } = await import("../src/db/schema.js");
const { SqliteShotRepo } = await import("../src/db/shot-repo.js");
const { SqliteBeanRepo } = await import("../src/db/bean-repo.js");
const { SqliteProfileRepo } = await import("../src/db/profile-repo.js");
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

const coffee = id(db.prepare("INSERT INTO coffee (name, created_at, updated_at) VALUES ('Out of the Dark', ?, ?)").run(now, now));
const bean = id(db.prepare("INSERT INTO bean (coffee_id, created_at, updated_at) VALUES (?, ?, ?)").run(coffee, now, now));
const grinder = id(db.prepare("INSERT INTO grinder (name, created_at, updated_at) VALUES ('DF83v', ?, ?)").run(now, now));
const basket = (type: string) => (db.prepare("SELECT id FROM basket WHERE type = ? ORDER BY id LIMIT 1").get(type) as { id: number }).id;
const he = id(db.prepare("INSERT INTO basket (name, type, created_at, updated_at) VALUES ('HE Mischief', 'he', ?, ?)").run(now, now));
const profiles = new SqliteProfileRepo();
const steps = { version: 1 as const, steps: [{ kind: "flow" as const, targetFlowGs: 1.4, exit: {} }] };
const lever = profiles.insert({ name: "Lever", scriptIdSingle: null, brewSteps: steps, yieldTargetSingleG: 36 });
const gagne = profiles.insert({ name: "Gagne", scriptIdSingle: null, brewSteps: steps, yieldTargetSingleG: 27 });

let t = now - 100_000;
const shot = (p: { profile: number; basket: number; grind: number; dose: number | null; note?: string; size?: string }) =>
  id(db.prepare(
    `INSERT INTO shot (profile_id, basket_id, shot_size, category, started_at, bean_id, grinder_id, grind_setting, dose_g, grind_note)
     VALUES (?, ?, ?, 'brew', ?, ?, ?, ?, ?, ?)`,
  ).run(p.profile, p.basket, p.size ?? "single", (t += 1000), bean, grinder, p.grind, p.dose, p.note ?? null));

// Gagne mit dem Einzelsieb bei 20, danach Lever bei 22 (der juengste Bezug mit der Bohne).
const gagneShot = shot({ profile: gagne, basket: basket("single"), grind: 20, dose: 12, note: "ok" });
shot({ profile: lever, basket: basket("double"), grind: 22, dose: 18, size: "double" });

const app = Fastify({ logger: false });
registerShotRoutes(app, {} as never, new SqliteShotRepo(), {} as never, new SqliteBeanRepo(), new SqliteProfileRepo(), {} as never, {} as never, () => {}, {} as never);
const defaults = async (q: Record<string, number>) => {
  const res = await app.inject({ method: "GET", url: `/api/shots/preshot-defaults?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}` });
  return res.json() as { grindSetting: number | null; doseG: number | null; grindSource: { stage: string; shotId: number; grindNote: string | null } | null };
};

test("Mahlgrad: Profil + Sieb vor der Bohne — Gagne bekommt 20, nicht die 22 vom letzten Lever-Bezug", async () => {
  const d = await defaults({ beanId: bean, grinderId: grinder, profileId: gagne, basketId: basket("single") });
  assert.equal(d.grindSetting, 20);
  assert.deepEqual([d.grindSource?.stage, d.grindSource?.shotId, d.grindSource?.grindNote], ["profileBasket", gagneShot, "ok"]);
  // ohne Bezug mit diesem Sieb: wie bisher die Bohne (juengster Bezug)
  const other = await defaults({ beanId: bean, grinderId: grinder, profileId: gagne, basketId: he });
  assert.deepEqual([other.grindSetting, other.grindSource?.stage], [22, "bean"]);
});

test("Dosis haengt am Sieb — das Doppelsieb bekommt 18 g, das Einzelsieb 12 g, ein neues Sieb die juengste der Bohne", async () => {
  assert.equal((await defaults({ beanId: bean, grinderId: grinder, basketId: basket("double") })).doseG, 18);
  assert.equal((await defaults({ beanId: bean, grinderId: grinder, basketId: basket("single") })).doseG, 12);
  assert.equal((await defaults({ beanId: bean, grinderId: grinder, basketId: he })).doseG, 18);
});

test("ohne Sieb im Aufruf gilt das des letzten Bezugs mit dem Profil (Start vom Chip)", async () => {
  const d = await defaults({ profileId: gagne });
  assert.deepEqual([d.grindSetting, d.doseG, d.grindSource?.stage], [20, 12, "profileBasket"]);
});

test("Historie nach Sieb filtern", async () => {
  const res = await new SqliteShotRepo().listShotsFiltered({ limit: 50, offset: 0, sort: "date_desc", category: "all", basketId: basket("double") });
  assert.deepEqual(res.shots.map((s) => s.profileId), [lever]);
});

test("Sieb korrigieren: shot_size folgt dem Typ, HE zaehlt als Einzel, unbekanntes Sieb → 400", async () => {
  const put = (basketId: number) => app.inject({ method: "PUT", url: `/api/shots/${gagneShot}`, payload: { basketId } });
  const row = () => ({ ...(db.prepare("SELECT basket_id, shot_size FROM shot WHERE id = ?").get(gagneShot) as { basket_id: number; shot_size: string }) });
  assert.equal((await put(basket("double"))).statusCode, 200);
  assert.deepEqual(row(), { basket_id: basket("double"), shot_size: "double" });
  assert.equal((await put(he)).statusCode, 200);
  assert.deepEqual(row(), { basket_id: he, shot_size: "single" });
  const bad = await put(9999);
  assert.equal(bad.statusCode, 400);
  assert.match((bad.json() as { error: string }).error, /Sieb 9999/);
  assert.deepEqual(row(), { basket_id: he, shot_size: "single" });
});

test("Dosis: ein Sieb ohne Bezug mit Nenndosis schlägt die Nenndosis vor, nicht die Dosis eines anderen Siebs", async () => {
  const triple = id(db.prepare("INSERT INTO basket (name, type, nominal_dose_g, created_at, updated_at) VALUES ('IMS 3er', 'single', 21, ?, ?)").run(now, now));
  assert.equal((await defaults({ beanId: bean, grinderId: grinder, basketId: triple })).doseG, 21);
  // mit eigenem Bezug gilt der Bezug
  shot({ profile: gagne, basket: triple, grind: 18, dose: 20.5 });
  assert.equal((await defaults({ beanId: bean, grinderId: grinder, basketId: triple })).doseG, 20.5);
});
