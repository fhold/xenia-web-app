/**
 * Netz Profil ↔ Bohne (Schnitt 4) gegen eine Wegwerf-DB: „Mit diesen Profilen“
 * nur mit Sieben, die Bezuege haben, „Lief mit“ je Variante, Historie nach Sorte
 * und Variante, und die Kaskaden-Stufe „gleicher Roestgrad“.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";

process.env.DB_PATH = path.join(os.tmpdir(), `network-${process.pid}-${Date.now()}.db`);

const { initDb, closeDb, getDb } = await import("../src/db/index.js");
const { applySchema } = await import("../src/db/schema.js");
const { SqliteShotRepo } = await import("../src/db/shot-repo.js");
const { SqliteBeanRepo } = await import("../src/db/bean-repo.js");
const { SqliteProfileRepo } = await import("../src/db/profile-repo.js");
const { registerNetworkRoutes } = await import("../src/routes/network.js");
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
const coffee = (name: string, roast: string) => id(db.prepare("INSERT INTO coffee (name, roast_level, created_at, updated_at) VALUES (?, ?, ?, ?)").run(name, roast, now, now));
const bean = (c: number) => id(db.prepare("INSERT INTO bean (coffee_id, created_at, updated_at) VALUES (?, ?, ?)").run(c, now, now));
const grinder = id(db.prepare("INSERT INTO grinder (name, created_at, updated_at) VALUES ('DF83v', ?, ?)").run(now, now));
const basket = (type: string) => (db.prepare("SELECT id FROM basket WHERE type = ? ORDER BY id LIMIT 1").get(type) as { id: number }).id;

const dark = coffee("Out of the Dark", "dark");
const blackcap = coffee("Blackcap", "dark");
const light = coffee("Hell", "light");
const ood = bean(dark), bc = bean(blackcap), hell = bean(light);
const profiles = new SqliteProfileRepo();
const steps = { version: 1 as const, steps: [{ kind: "flow" as const, targetFlowGs: 1.4, exit: {} }] };
const gagne = profiles.insert({ name: "Gagne", scriptIdSingle: null, brewSteps: steps, yieldTargetSingleG: 27, yieldTargetDoubleG: 40 });
const [v1, v2] = profiles.findById(gagne)!.variants!;
let t = now - 100_000;
const shot = (b: number, variantId: number, basketId: number, grind: number, rating: number | null) =>
  id(db.prepare(
    `INSERT INTO shot (profile_id, variant_id, basket_id, shot_size, category, started_at, ended_at, bean_id, grinder_id, grind_setting, rating)
     VALUES (?, ?, ?, 'single', 'brew', ?, ?, ?, ?, ?, ?)`,
  ).run(gagne, variantId, basketId, (t += 1000), t + 30_000, b, grinder, grind, rating));
shot(ood, v1!.id, basket("single"), 20, 4);
shot(ood, v1!.id, basket("single"), 19.5, null);
shot(bc, v2!.id, basket("double"), 18, 3);
shot(hell, v1!.id, basket("single"), 23, null);

const app = Fastify({ logger: false });
const shots = new SqliteShotRepo();
registerNetworkRoutes(app, shots);
registerShotRoutes(app, {} as never, shots, {} as never, new SqliteBeanRepo(), profiles, {} as never, {} as never, () => {}, {} as never);
const get = async (url: string) => (await app.inject({ url })).json();

test("Sorte: je Sieb und Mühle die Profile — nur Siebe mit Bezügen, das Doppelsieb ohne Bezug fehlt", async () => {
  const c = await get(`/api/network/coffee/${dark}`);
  assert.deepEqual(Object.keys(c), ["groups"]);
  assert.deepEqual(c.groups.map((g: { basketId: number }) => g.basketId), [basket("single")]);
  assert.deepEqual([c.groups[0].rows[0].label, c.groups[0].rows[0].n, c.groups[0].rows[0].grindMin, c.groups[0].rows[0].grindMax],
    ["Gagne", 2, 19.5, 20]);
});

test("Profil: „Lief mit“ je Variante, Zeilen je Sorte", async () => {
  const p = await get(`/api/network/profile/${gagne}`);
  const g1 = p.groups.find((g: { variantId: number }) => g.variantId === v1!.id);
  assert.deepEqual(g1.rows.map((r: { label: string; n: number }) => [r.label, r.n]), [["Out of the Dark", 2], ["Hell", 1]]);
});

test("Historie nach Sorte und Variante", async () => {
  const bySorte = await get(`/api/shots?category=all&coffee_id=${dark}`);
  assert.equal(bySorte.total, 2);
  const byVariant = await get(`/api/shots?category=all&variant_id=${v2!.id}`);
  assert.equal(byVariant.total, 1);
});

test("Kaskade: neue Bohne bekommt den Mahlgrad einer Sorte gleichen Röstgrads mit Profil + Sieb + Mühle", async () => {
  const fresh = bean(coffee("Neu dunkel", "dark"));
  const d = await get(`/api/shots/preshot-defaults?beanId=${fresh}&grinderId=${grinder}&profileId=${gagne}&basketId=${basket("double")}`);
  assert.deepEqual([d.grindSetting, d.grindSource.stage], [18, "roast"]);
});
