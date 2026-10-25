/**
 * Varianten (vereinter Editor, Schnitt 3): Profile ohne Varianten bekommen sie
 * aus den alten Profilspalten — an Ort und Stelle, damit IDs stabil bleiben.
 * Bezuege bekommen Variante und Sieb aus shot_size; ein benutztes Sieb laesst
 * sich nicht loeschen. Seit 3c fuehren die Varianten (Speichern, Pruefen,
 * abgeleitete Spalten), der Start ueberschreibt sie nicht mehr.
 *
 * Runner: node:test via tsx — Wegwerf-DB.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";

process.env.DB_PATH = path.join(os.tmpdir(), `variants-${process.pid}-${Date.now()}.db`);

const { initDb, closeDb, getDb } = await import("../src/db/index.js");
const { applySchema } = await import("../src/db/schema.js");
const { SqliteProfileRepo } = await import("../src/db/profile-repo.js");
const { SqliteBasketRepo } = await import("../src/db/basket-repo.js");
const { registerBasketRoutes } = await import("../src/routes/baskets.js");
const { backfillShotVariantBasket, saveVariants, checkVariants, legacyFromVariants } = await import("../src/db/variant-repo.js");

after(() => {
  closeDb();
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DB_PATH!}${s}`, { force: true });
});

initDb();
applySchema();
const db = getDb();
const profiles = new SqliteProfileRepo();
for (const p of profiles.listAll()) profiles.delete(p.id); // Beispiel-Profile des frischen Schemas

const now = Date.now();
for (const id of [19, 28, 30]) {
  db.prepare("INSERT INTO xenia_script (id, title, content, fetched_at) VALUES (?, ?, '1;13;4 9000 0;12 30000;7;', ?)").run(id, `S${id}`, now);
}
const steps = { version: 1 as const, steps: [{ kind: "flow" as const, targetFlowGs: 1.4, exit: {} }] };
const steps2 = { version: 1 as const, steps: [{ kind: "flow" as const, targetFlowGs: 2.4, exit: {} }] };

type V = { id: number; legacy_slot: string; name: string; sort_order: number; default_basket_id: number | null; yield_g: number | null; script_id: number | null; brew_steps: string | null; same_as_id: number | null };
const variants = (profileId: number) =>
  db.prepare("SELECT * FROM profile_variant WHERE profile_id = ? ORDER BY sort_order").all(profileId) as unknown as V[];
const basketOf = (type: string) => (db.prepare("SELECT id FROM basket WHERE type = ? ORDER BY id LIMIT 1").get(type) as { id: number }).id;

const base = { isFavorite: false, yieldTargetSingleG: 25, yieldTargetDoubleG: null, scriptIdDouble: null };
const londinium = profiles.insert({ ...base, name: "Londinium", scriptIdSingle: 19, scriptIdDouble: 28, yieldTargetDoubleG: 36 });
const sixbar = profiles.insert({ ...base, name: "6bar flat", scriptIdSingle: 30, scriptIdDouble: 30, yieldTargetDoubleG: 36 });
const flow = profiles.insert({ ...base, name: "Flow", scriptIdSingle: null, brewSteps: steps });
const flowDouble = profiles.insert({ ...base, name: "Flow 2", scriptIdSingle: null, brewSteps: steps, yieldTargetDoubleG: 40 });

test("jedes Profil bekommt seine Varianten wie die heutigen Plätze", () => {
  const l = variants(londinium);
  assert.deepEqual(l.map((v) => [v.legacy_slot, v.name, v.script_id, v.yield_g, v.same_as_id]), [["single", "Einzel", 19, 25, null], ["double", "Doppel", 28, 36, null]]);
  assert.deepEqual(l.map((v) => v.default_basket_id), [basketOf("single"), basketOf("double")]);
  // gleiches Skript fuer beide = „wie Variante Einzel“
  const s = variants(sixbar);
  assert.deepEqual(s.map((v) => [v.script_id, v.yield_g, v.same_as_id]), [[30, 25, null], [null, 36, s[0]!.id]]);
  assert.deepEqual(variants(flow).map((v) => [v.legacy_slot, v.script_id, JSON.parse(v.brew_steps!).steps[0].targetFlowGs]), [["single", null, 1.4]]);
  const f2 = variants(flowDouble);
  assert.deepEqual(f2.map((v) => [v.yield_g, v.brew_steps === null, v.same_as_id]), [[25, false, null], [40, true, f2[0]!.id]]);
});

test("Ändern spiegelt an Ort und Stelle — IDs bleiben, ein weggenommenes Doppel verschwindet", () => {
  const before = variants(flowDouble);
  profiles.update(flowDouble, { brewStepsDouble: steps2, yieldTargetSingleG: 26 });
  const mid = variants(flowDouble);
  assert.deepEqual(mid.map((v) => v.id), before.map((v) => v.id));
  assert.deepEqual(mid.map((v) => [v.yield_g, v.same_as_id, v.brew_steps && JSON.parse(v.brew_steps).steps[0].targetFlowGs]), [[26, null, 1.4], [40, null, 2.4]]);
  profiles.update(flowDouble, { yieldTargetDoubleG: null, brewStepsDouble: null });
  assert.deepEqual(variants(flowDouble).map((v) => v.id), [before[0]!.id]);
  // Skript → App: Skript fort, Stufen da, gleiche Variante
  const l0 = variants(londinium)[0]!.id;
  profiles.update(londinium, { scriptIdSingle: null, scriptIdDouble: null, brewSteps: steps });
  const l = variants(londinium);
  assert.equal(l[0]!.id, l0);
  assert.deepEqual(l.map((v) => [v.script_id, v.brew_steps !== null]), [[null, true], [null, false]]); // Doppel: 2×-Yield ohne eigene Stufen = wie Einzel
  assert.equal(l[1]!.same_as_id, l0);
});

test("Bezüge bekommen Sieb und Variante aus shot_size — nur leere Felder, Wartung ohne Sieb, die Variante nur beim Anlegen der Spalte", () => {
  const ins = db.prepare("INSERT INTO shot (profile_id, shot_size, category, started_at) VALUES (?, ?, ?, ?)");
  const s1 = Number((ins.run(sixbar, "single", "brew", now) as { lastInsertRowid: number }).lastInsertRowid);
  const s2 = Number((ins.run(sixbar, "double", "brew", now) as { lastInsertRowid: number }).lastInsertRowid);
  const s3 = Number((ins.run(sixbar, "single", "maintenance", now) as { lastInsertRowid: number }).lastInsertRowid);
  const s4 = Number((ins.run(null, "single", "brew", now) as { lastInsertRowid: number }).lastInsertRowid);
  const row = (id: number) => ({ ...(db.prepare("SELECT variant_id, basket_id FROM shot WHERE id = ?").get(id) as { variant_id: number | null; basket_id: number | null }) });
  // Die Spalte gibt es schon: der Start traegt nur das Sieb nach — eine leere
  // Variante heisst jetzt „geloescht“.
  applySchema();
  assert.deepEqual(row(s1), { variant_id: null, basket_id: basketOf("single") });
  backfillShotVariantBasket(true);
  backfillShotVariantBasket(true);
  const [vs, vd] = variants(sixbar);
  assert.deepEqual(row(s1), { variant_id: vs!.id, basket_id: basketOf("single") });
  assert.deepEqual(row(s2), { variant_id: vd!.id, basket_id: basketOf("double") });
  assert.deepEqual(row(s3), { variant_id: vs!.id, basket_id: null });
  assert.deepEqual(row(s4), { variant_id: null, basket_id: basketOf("single") });
  // schon gesetzte Felder bleiben
  db.prepare("UPDATE shot SET basket_id = ? WHERE id = ?").run(basketOf("double"), s1);
  applySchema();
  assert.equal(row(s1).basket_id, basketOf("double"));
});

test("ein benutztes Sieb lässt sich nicht löschen, ein freies schon", async () => {
  const baskets = new SqliteBasketRepo();
  const app = Fastify();
  registerBasketRoutes(app, baskets);
  const used = await app.inject({ method: "DELETE", url: `/api/baskets/${basketOf("single")}` });
  assert.equal(used.statusCode, 409);
  assert.match((used.json() as { error: string }).error, /benutzt/);
  const free = baskets.insert({ name: "HE-Sieb", type: "he" });
  assert.equal((await app.inject({ method: "DELETE", url: `/api/baskets/${free}` })).statusCode, 200);
});

test("Profil löschen nimmt seine Varianten mit, Bezüge behalten ihr Sieb", () => {
  const shot = Number((db.prepare("INSERT INTO shot (profile_id, shot_size, category, started_at) VALUES (?, 'single', 'brew', ?)").run(flow, now) as { lastInsertRowid: number }).lastInsertRowid);
  applySchema();
  profiles.delete(flow);
  assert.equal(variants(flow).length, 0);
  const r = db.prepare("SELECT profile_id, variant_id, basket_id FROM shot WHERE id = ?").get(shot) as { profile_id: number | null; variant_id: number | null; basket_id: number | null };
  assert.deepEqual([r.profile_id, r.variant_id, r.basket_id !== null], [null, null, true]);
});

test("ein zweiter Lauf schreibt nichts (auch kein updated_at); Wartung bekommt kein Sieb", () => {
  const snap = () => JSON.stringify(db.prepare("SELECT * FROM profile_variant ORDER BY id").all());
  const before = snap();
  applySchema();
  assert.equal(snap(), before);
  db.prepare("INSERT INTO xenia_script (id, title, content, fetched_at, category_auto) VALUES (26, 'Cleaning', '1;13;4 9000 1000;12 20000;7;', ?, 'maintenance')").run(now);
  // Wartung sagt seit der Profil-Art das Profil, nicht mehr das Skript.
  const clean = profiles.insert({ ...base, name: "Rückspülen", kind: "maintenance", scriptIdSingle: 26, yieldTargetSingleG: null });
  assert.deepEqual(variants(clean).map((v) => [v.script_id, v.default_basket_id]), [[26, null]]);
});

// --- Start nach Variante (Schnitt 3d) ---------------------------------------------

const { resolveStart: resolve } = await import("../src/db/variant-repo.js");
const { ShotRecorder } = await import("../src/shots/recorder.js");
const basketRepo = new SqliteBasketRepo();
const resolveStart = (profileId: number, req: { variantId?: number | null; basketId?: number | null; shotSize: "single" | "double" }) =>
  resolve(profiles.findById(profileId)!.variants ?? [], (id) => basketRepo.findById(id)?.type, req);

test("Start ohne Variante: wie bisher der Platz — dazu Variante und Sieb für die Aufzeichnung", () => {
  const [vs, vd] = variants(sixbar);
  const single = resolveStart(sixbar, { shotSize: "single" });
  assert.deepEqual(single, { ok: true, fromVariant: false, variantId: vs!.id, basketId: basketOf("single"), shotSize: "single", scriptId: null, brewSteps: null, yieldG: null });
  const dbl = resolveStart(sixbar, { shotSize: "double" });
  assert.ok(dbl.ok && dbl.variantId === vd!.id && dbl.basketId === basketOf("double") && dbl.shotSize === "double");
});

test("Start mit Variante: Kurve aus ihr („wie Variante X“ fährt die von X), Yield eigen, shot_size folgt dem Sieb", () => {
  const [vs, vd] = variants(sixbar);
  const d = resolveStart(sixbar, { variantId: vd!.id, shotSize: "single" });
  assert.ok(d.ok);
  if (d.ok) assert.deepEqual([d.scriptId, d.yieldG, d.basketId, d.shotSize], [30, 36, basketOf("double"), "double"]);
  // Einzel-Variante mit dem Doppelsieb: Sieb gewinnt fuer shot_size
  const s = resolveStart(sixbar, { variantId: vs!.id, basketId: basketOf("double"), shotSize: "single" });
  assert.ok(s.ok && s.scriptId === 30 && s.yieldG === 25 && s.shotSize === "double");
  // HE-Sieb zaehlt als Einzel
  const he = basketRepo.insert({ name: "HE", type: "he" });
  const h = resolveStart(sixbar, { variantId: vs!.id, basketId: he, shotSize: "double" });
  assert.ok(h.ok && h.shotSize === "single" && h.basketId === he);
});

test("Start mit fremder Variante oder unbekanntem Sieb wird abgelehnt", () => {
  const other = variants(londinium)[0]!.id;
  const r = resolveStart(sixbar, { variantId: other, shotSize: "single" });
  assert.equal(r.ok, false);
  assert.equal(resolveStart(sixbar, { basketId: 9999, shotSize: "single" }).ok, false);
});

test("Rekorder schreibt Variante und Sieb in den Bezug", () => {
  let created: Record<string, unknown> | null = null;
  const repo = {
    finalizeAllOpen: () => 0,
    createShot: (input: Record<string, unknown>) => { created = input; return 1; },
    appendSample: () => {},
    finalizeShot: () => {},
    findById: () => null,
    logAutoCalibration: () => {},
    appendStageTransitions: () => {},
    rememberBrewDef: () => "h",
  };
  const noopLog = { child: () => noopLog, info: () => {}, warn: () => {}, error: () => {} };
  const recorder = new ShotRecorder(repo as never, { get: () => null, set: () => {} } as never, {} as never, noopLog as never);
  recorder.armForExecute({
    profileId: sixbar, variantId: 77, basketId: 3, profileName: "6bar flat", scriptId: 30, shotSize: "double",
    category: "brew", hasPumpAction: true, hasCmd27: false, cmd27Value: null, yieldTargetG: null,
    beanId: null, grinderId: null, grindSetting: null, grinderRpm: null, doseG: null, notes: null,
  });
  recorder.onFrame({ machineStatus: 3, timestamp: Date.now() } as never);
  assert.ok(created);
  assert.deepEqual([created!["variantId"], created!["basketId"], created!["shotSize"]], [77, 3, "double"]);
});

// --- Speichern: die Varianten fuehren (Schnitt 3c) ---------------------------------

const { SqliteScriptRepo } = await import("../src/db/script-repo.js");
const { registerProfileRoutes } = await import("../src/routes/profiles.js");
type ApiProfile = { id: number; name: string; scriptIdSingle: number | null; yieldTargetSingleG: number | null; brewSteps: { steps: unknown[] } | null;
  variants: { id: number; name: string; legacySlot: string | null; scriptId: number | null; yieldG: number | null }[] };

test("3c: der Start legt nur fehlende Varianten an — gespeicherte bleiben, auch wenn Name oder Notiz sich ändern", () => {
  const p = profiles.insert({ ...base, name: "Gespeichert", scriptIdSingle: 19, scriptIdDouble: 28, yieldTargetDoubleG: 36 });
  const [a, b] = variants(p);
  saveVariants(p, [
    { id: b!.id, name: "2er", defaultBasketId: basketOf("double"), yieldG: 38, scriptId: 28, brewSteps: null },
    { id: a!.id, name: "1er", defaultBasketId: basketOf("single"), yieldG: 25, scriptId: 19, brewSteps: null },
    { name: "Turbo", defaultBasketId: basketOf("single"), yieldG: 40, scriptId: null, brewSteps: null, sameAs: 1 },
  ]);
  const snap = JSON.stringify(variants(p));
  const bare = Number((db.prepare("INSERT INTO profile (name, script_single, yield_single_g) VALUES ('Nackt', 30, 20)").run() as { lastInsertRowid: number }).lastInsertRowid);
  applySchema();
  profiles.update(p, { name: "Gespeichert 2", notes: "gröber" });
  assert.equal(JSON.stringify(variants(p)), snap);
  assert.deepEqual(variants(bare).map((v) => [v.name, v.script_id]), [["Einzel", 30]]);
});

test("3c: Speichern ändert per id, legt an, löscht — Plätze und alte Spalten folgen der Reihenfolge", () => {
  const p = profiles.insert({ ...base, name: "Umbau", scriptIdSingle: 19, scriptIdDouble: 28, yieldTargetDoubleG: 36 });
  const [a, b] = variants(p);
  const shot = Number((db.prepare("INSERT INTO shot (profile_id, variant_id, shot_size, category, started_at) VALUES (?, ?, 'single', 'brew', ?)")
    .run(p, a!.id, now) as { lastInsertRowid: number }).lastInsertRowid);
  saveVariants(p, [
    { id: b!.id, name: " 2er ", defaultBasketId: basketOf("double"), yieldG: 36, scriptId: 28, brewSteps: null },
    { name: "HE", defaultBasketId: null, yieldG: 30, scriptId: null, brewSteps: null, sameAs: 0 },
  ]);
  const v = variants(p);
  assert.deepEqual(v.map((x) => [x.id === b!.id, x.name, x.legacy_slot, x.sort_order, x.script_id, x.same_as_id]),
    [[true, "2er", "single", 0, 28, null], [false, "HE", "double", 1, null, b!.id]]);
  const cols = db.prepare("SELECT script_single, script_double, yield_single_g, yield_double_g FROM profile WHERE id = ?").get(p);
  assert.deepEqual({ ...cols }, { script_single: 28, script_double: 28, yield_single_g: 36, yield_double_g: 30 });
  // Der Bezug der geloeschten Variante bekommt keine fremde — auch nicht beim naechsten Start.
  applySchema();
  assert.equal((db.prepare("SELECT variant_id FROM shot WHERE id = ?").get(shot) as { variant_id: number | null }).variant_id, null);
});

test("3c: alte Spalten aus App-Varianten — „wie Einzel“ bleibt ohne eigene 2×-Stufen", () => {
  const one = { name: "1er", defaultBasketId: null, yieldG: 27, scriptId: null, brewSteps: steps };
  const same = legacyFromVariants([one, { name: "2er", defaultBasketId: null, yieldG: 40, scriptId: null, brewSteps: null, sameAs: 0 }]);
  assert.deepEqual([same.brewSteps, same.brewStepsDouble, same.yieldTargetSingleG, same.yieldTargetDoubleG, same.scriptIdSingle], [steps, null, 27, 40, null]);
  const own = legacyFromVariants([one, { name: "2er", defaultBasketId: null, yieldG: 40, scriptId: null, brewSteps: steps2 }]);
  assert.deepEqual(own.brewStepsDouble, steps2);
});

test("3c: Prüfung vor dem Speichern", () => {
  const has = { basket: (id: number) => id === basketOf("single"), script: (id: number) => id === 19, validSteps: (bp: unknown) => (bp === steps ? null : "kaputt") };
  const ok = { name: "1er", defaultBasketId: basketOf("single"), yieldG: 25, scriptId: 19, brewSteps: null };
  const app = { ...ok, scriptId: null, brewSteps: steps };
  assert.equal(checkVariants([ok, { ...ok, name: "2er", scriptId: null, sameAs: 0 }], has), null);
  const bad: Array<[unknown, RegExp]> = [
    [[], /mindestens eine/],
    [null, /mindestens eine/],
    [[ok, { ...ok }], /zweimal/],
    [[{ ...ok, name: " " }], /Name fehlt/],
    [[{ ...ok, name: 5 }], /ungültig/],
    [[{ ...ok, yieldG: "25" }], /ungültige Zahl/],
    [[{ ...ok, brewSteps: steps }], /genau eine Kurve/],
    [[{ ...ok, scriptId: null }], /genau eine Kurve/],
    [[ok, { ...ok, name: "b", scriptId: null, sameAs: 1 }], /eigener Kurve/],
    [[ok, { ...ok, name: "b", scriptId: null, sameAs: 5 }], /eigener Kurve/],
    [[ok, { ...ok, name: "b", scriptId: null, sameAs: 0 }, { ...ok, name: "c", scriptId: null, sameAs: 1 }], /eigener Kurve/],
    [[{ ...ok, defaultBasketId: 999 }], /Sieb 999/],
    [[{ ...ok, scriptId: 77 }], /Skript 77/],
    [[{ ...app, brewSteps: steps2 }], /kaputt/],
    [[{ ...app, yieldG: null }], /Yield/],
    [[app, { ...ok, name: "b", scriptId: null, yieldG: null, sameAs: 0 }], /Yield/],
  ];
  for (const [list, re] of bad) assert.match(checkVariants(list, has) ?? "", re, JSON.stringify(list));
});

test("3c: Profil-Route speichert Varianten — anlegen und ändern, alte Kurven-Felder zählen dann nicht, Fehler mit 400", async () => {
  const app = Fastify();
  registerProfileRoutes(app, profiles, new SqliteScriptRepo(), () => {});
  const created = await app.inject({
    method: "POST", url: "/api/profiles", payload: {
      name: "Neu", scriptIdSingle: null, variants: [
        { name: "1er", defaultBasketId: basketOf("single"), yieldG: 27, scriptId: null, brewSteps: steps },
        { name: "Spülen", defaultBasketId: null, yieldG: null, scriptId: 30, brewSteps: null },
      ],
    },
  });
  assert.equal(created.statusCode, 200, created.body);
  const c = created.json() as ApiProfile;
  assert.deepEqual(c.variants.map((v) => [v.name, v.legacySlot, v.scriptId]), [["1er", "single", null], ["Spülen", "double", 30]]);
  assert.deepEqual([c.yieldTargetSingleG, c.brewSteps?.steps.length], [27, 1]);
  const one = c.variants[0]!;
  const put = await app.inject({
    method: "PUT", url: `/api/profiles/${c.id}`, payload: {
      name: "Neu 2", scriptIdSingle: 19,
      variants: [{ id: one.id, name: "Einer", defaultBasketId: basketOf("single"), yieldG: 28, scriptId: null, brewSteps: steps }],
    },
  });
  assert.equal(put.statusCode, 200, put.body);
  const u = put.json() as ApiProfile;
  assert.deepEqual([u.name, u.scriptIdSingle, u.variants.map((v) => [v.id, v.name, v.yieldG])], ["Neu 2", null, [[one.id, "Einer", 28]]]);
  const bad = await app.inject({
    method: "PUT", url: `/api/profiles/${c.id}`,
    payload: { variants: [{ name: "x", defaultBasketId: null, yieldG: null, scriptId: null, brewSteps: steps }] },
  });
  assert.equal(bad.statusCode, 400);
  assert.match((bad.json() as { error: string }).error, /Yield/);
  assert.equal(profiles.findById(c.id)!.variants![0]!.name, "Einer");
});

test("3c: ein Skript, das nur eine dritte Variante fährt, gilt als benutzt", () => {
  db.prepare("INSERT INTO xenia_script (id, title, content, fetched_at, orphaned_at) VALUES (31, 'S31', '1;13;4 9000 0;12 30000;7;', ?, ?)").run(now, now);
  const p = profiles.insert({ ...base, name: "Drei", scriptIdSingle: 19 });
  saveVariants(p, [
    { name: "a", defaultBasketId: null, yieldG: null, scriptId: 19, brewSteps: null },
    { name: "b", defaultBasketId: null, yieldG: null, scriptId: null, brewSteps: null, sameAs: 0 },
    { name: "c", defaultBasketId: null, yieldG: null, scriptId: 31, brewSteps: null },
  ]);
  const r = new SqliteScriptRepo().deleteOrphaned();
  assert.ok(r.blocked.some((x) => x.id === 31) && !r.deleted.includes(31));
});

test("Phasennamen: zum eigenen Skript gespeichert, an App-Varianten nicht; ungültige abgelehnt", () => {
  const p = profiles.insert({ ...base, name: "Namen", scriptIdSingle: 19 });
  saveVariants(p, [
    { name: "a", defaultBasketId: null, yieldG: null, scriptId: 19, brewSteps: null, phaseNames: ["Füllen", null, "Ziehen"] },
    { name: "b", defaultBasketId: null, yieldG: 30, scriptId: null, brewSteps: steps, phaseNames: ["x"] },
  ]);
  const got = profiles.findById(p)!.variants!.map((v) => v.phaseNames);
  assert.deepEqual(got, [["Füllen", null, "Ziehen"], null]);
  const has = { basket: () => true, script: () => true, validSteps: () => null };
  const v = { name: "a", defaultBasketId: null, yieldG: null, scriptId: 19, brewSteps: null };
  assert.match(checkVariants([{ ...v, phaseNames: ["x".repeat(41)] }], has) ?? "", /Phasennamen/);
  assert.match(checkVariants([{ ...v, phaseNames: "x" }], has) ?? "", /Phasennamen/);
  assert.equal(checkVariants([{ ...v, phaseNames: [null, "ok"] }], has), null);
});

test("ohne Yield: App-Variante gilt, wenn die letzte Phase einen Ausstieg hat (sie beendet den Bezug)", () => {
  const ends = { version: 1 as const, steps: [{ kind: "flow" as const, targetFlowGs: 2, exit: { seconds: 5 } }, { kind: "flow" as const, targetFlowGs: 1.5, exit: { seconds: 30 } }] };
  const has = { basket: () => true, script: () => true, validSteps: () => null };
  const v = { name: "Tee", defaultBasketId: null, yieldG: null, scriptId: null, brewSteps: ends };
  assert.equal(checkVariants([v], has), null);
  assert.equal(checkVariants([v, { ...v, name: "b", brewSteps: null, sameAs: 0 }], has), null);
  assert.match(checkVariants([{ ...v, brewSteps: steps }], has) ?? "", /Yield — oder einen Ausstieg in der letzten Phase/);
});
