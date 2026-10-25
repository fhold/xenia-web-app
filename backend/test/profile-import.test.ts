/**
 * Profil-Import (2026-10-20) gegen eine Attrappe der Maschine:
 *  - App-Profil: ohne Maschine, Sieb per Name, „wie Variante“, Name mit Zaehler
 *  - Skript-Profil: fehlendes Skript wird angelegt, identisches verwendet,
 *    gleicher Titel mit anderem Text nur nach Wahl (vorhandenes / neu mit Zaehler)
 *  - alles geprueft, bevor geschrieben wird; waehrend eines Bezugs kein Skript-Import
 *  - Export des importierten Profils = die Datei (Hin und zurueck)
 *
 * Runner: node:test via tsx — Wegwerf-DB.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";

process.env.DB_PATH = path.join(os.tmpdir(), `profile-import-${process.pid}-${Date.now()}.db`);

const { initDb, closeDb } = await import("../src/db/index.js");
const { applySchema } = await import("../src/db/schema.js");
const { SqliteProfileRepo } = await import("../src/db/profile-repo.js");
const { SqliteScriptRepo } = await import("../src/db/script-repo.js");
const { SqliteBasketRepo } = await import("../src/db/basket-repo.js");
const { registerProfileImportRoutes } = await import("../src/routes/profile-import.js");
const { buildProfileFile } = await import("../../shared/src/profile-file.js");
import type { XeniaClient } from "../src/xenia/client.js";
import type { ShotRecorder } from "../src/shots/recorder.js";
import type { BrewProfile } from "../../shared/src/types.js";
import type { ImportPlan, ProfileImportResult } from "../../shared/src/profile-file.js";

after(() => {
  closeDb();
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DB_PATH!}${s}`, { force: true });
});

initDb();
applySchema();
const profiles = new SqliteProfileRepo();
const scripts = new SqliteScriptRepo();
const baskets = new SqliteBasketRepo();
const stepDown = baskets.insert({ name: "Step-Down", description: "Stufensieb", nominalDoseG: 15 });

// --- Attrappe der Maschine -----------------------------------------------------
const machine = new Map<number, { Title: string; Content: string }>([
  [10, { Title: "Rueckspuelen", Content: "1;13;4 9000 1000;12 20000;7;" }],
  [11, { Title: "Londinium Single", Content: "1;13;4 8000 1000;12 25000;7;" }],
]);
let machineDown = false;
const creates: { scriptId: number | null; name: string }[] = [];
const client = {
  scriptsList: async () => {
    if (machineDown) throw new Error("ECONNREFUSED");
    const ids = [...machine.keys()];
    return { index_list: ids, title_list: ids.map((i) => machine.get(i)!.Title) };
  },
  scriptRead: async (id: number) => machine.get(id)!,
  scriptCreate: async (a: { scriptId: number; name: string; instruction: string }) => {
    creates.push({ scriptId: a.scriptId, name: a.name });
    machine.set(a.scriptId, { Title: a.name, Content: a.instruction });
    return {};
  },
} as unknown as XeniaClient;
const recorder = { activeShotId: null as number | null, isMaintenanceActive: false } as unknown as ShotRecorder & { activeShotId: number | null };
let brewing = false;
let changed = 0;

const app = Fastify();
registerProfileImportRoutes(app, client, scripts, profiles, recorder,
  () => (brewing ? { machineStatus: 3 } : { machineStatus: 0 }) as never, () => { changed++; });
await app.ready();

const post = async (url: string, payload: unknown) => {
  const res = await app.inject({ method: "POST", url, payload: payload as object });
  return { status: res.statusCode, body: res.json() };
};

const GAGNE: BrewProfile = {
  version: 1,
  steps: [
    { kind: "preinfusion", name: "Füllen", gentleness: "normal", exit: { pressureBar: 4, seconds: 25 } },
    { kind: "pressure", name: "Druckspitze", targetPressureBar: 9, rampMs: 3000, exit: { seconds: 7 } },
    { kind: "flow", name: "Fluss halten", targetFlowGs: 1.5, adoptFlow: true, maxPressureBar: 9.5, exit: {} },
  ],
} as BrewProfile;
const LONDINIUM = "1;13;4 2000 2000;12 10000;6;12 12000;4 6000 2000;12 60000;7;";

const appFile = {
  kind: "xenia-profile", version: 3,
  profile: { name: "Adaptive Gagné · 9 bar", kind: "brew", isTrial: true, fit: ["dark", "light"], targetTempC: 88, notes: "MG 19,5", variants: [
    { name: "Einzel", basket: { name: "Einersieb Xenia", description: null, nominalDoseG: null }, yieldG: 27, sameAs: null, script: null, phaseNames: null, brewSteps: GAGNE },
    { name: "Step-Down", basket: { name: "step-down", description: null, nominalDoseG: 15 }, yieldG: 27, sameAs: "Einzel", script: null, phaseNames: null, brewSteps: null },
  ] },
};
const scriptFile = (title: string, content: string, double = false) => ({
  kind: "xenia-profile", version: 3,
  profile: { name: "Londinium", kind: "brew", isTrial: false, fit: [], targetTempC: 92, notes: null, variants: [
    { name: "Einzel", basket: null, yieldG: 36, sameAs: null, script: { title, content }, phaseNames: ["Preinfusion", null], brewSteps: null },
    ...(double ? [{ name: "Doppel", basket: null, yieldG: 40, sameAs: null, script: { title: `${title} copy`, content }, phaseNames: null, brewSteps: null }] : []),
  ] },
});

test("App-Profil: braucht die Maschine nicht, Sieb per Name, „wie Variante“, fehlendes Sieb gemeldet", async () => {
  machineDown = true;
  const preview = await post("/api/profiles/import/preview", { file: appFile });
  assert.equal(preview.status, 200);
  const plan = preview.body as ImportPlan;
  assert.equal(plan.name, "Adaptive Gagné · 9 bar");
  assert.deepEqual(plan.variants.map((v) => [v.curve, v.basketId, v.missingBasket]), [["steps", null, "Einersieb Xenia"], ["sameAs", stepDown, null]]);

  const res = await post("/api/profiles/import", { file: appFile, choices: {} });
  assert.equal(res.status, 200);
  const r = res.body as ProfileImportResult;
  assert.deepEqual(r.missingBaskets, ["Einersieb Xenia"]);
  assert.deepEqual(r.createdScripts, []);
  const p = profiles.findById(r.profile.id)!;
  assert.equal(p.isTrial, true);
  assert.equal(p.targetTempC, 88);
  assert.equal(p.isFavorite, false);
  const [einzel, step] = p.variants!;
  assert.equal(step!.sameAsId, einzel!.id);
  assert.equal(step!.defaultBasketId, stepDown);
  assert.deepEqual(einzel!.brewSteps, GAGNE);
  assert.equal(changed, 1);
  machineDown = false;
});

test("Name gibt es schon → „Name (2)“, das vorhandene Profil bleibt", async () => {
  const before = profiles.listAll().length;
  const res = await post("/api/profiles/import", { file: appFile });
  assert.equal(res.status, 200);
  assert.equal((res.body as ProfileImportResult).profile.name, "Adaptive Gagné · 9 bar (2)");
  assert.equal(profiles.listAll().length, before + 1);
});

test("Skript fehlt auf der Maschine → wird auf dem kleinsten freien Platz angelegt", async () => {
  const preview = await post("/api/profiles/import/preview", { file: scriptFile("Londinium Neu", LONDINIUM) });
  assert.deepEqual((preview.body as ImportPlan).variants[0]!.script, { status: "new", title: "Londinium Neu" });
  assert.equal(creates.length, 0, "die Vorschau schreibt nichts");

  const res = await post("/api/profiles/import", { file: scriptFile("Londinium Neu", LONDINIUM) });
  assert.equal(res.status, 200);
  const r = res.body as ProfileImportResult;
  assert.deepEqual(creates, [{ scriptId: 12, name: "Londinium Neu" }]);
  assert.deepEqual(r.createdScripts, [{ id: 12, title: "Londinium Neu" }]);
  const v = profiles.findById(r.profile.id)!.variants![0]!;
  assert.equal(v.scriptId, 12);
  assert.deepEqual(v.phaseNames, ["Preinfusion", null]);
});

test("Identisches Skript liegt schon da → wird verwendet, nichts angelegt (auch unter anderem Titel)", async () => {
  creates.length = 0;
  const res = await post("/api/profiles/import", { file: scriptFile("Ganz anderer Titel", LONDINIUM) });
  assert.equal(res.status, 200);
  const r = res.body as ProfileImportResult;
  assert.equal(creates.length, 0);
  assert.deepEqual(r.reusedScripts, [{ id: 12, title: "Londinium Neu" }]);
  assert.equal(profiles.findById(r.profile.id)!.variants![0]!.scriptId, 12);
});

test("Gleicher Titel, anderer Text → ohne Wahl kein Import; „neu“ legt mit Zähler an, „vorhandenes“ verwendet es", async () => {
  creates.length = 0;
  const file = scriptFile("Londinium Single", "1;13;4 7000 1000;12 30000;7;");
  const preview = await post("/api/profiles/import/preview", { file });
  assert.equal(preview.status, 200);
  assert.deepEqual((preview.body as ImportPlan).variants[0]!.script, { status: "conflict", title: "Londinium Single", scriptId: 11 });

  const none = await post("/api/profiles/import", { file });
  assert.equal(none.status, 400);
  assert.match(none.body.error, /vorhandenes verwenden oder neu anlegen/);
  assert.equal(creates.length, 0);

  const reuse = await post("/api/profiles/import", { file, choices: { 0: "reuse" } });
  assert.equal(reuse.status, 200);
  assert.equal(profiles.findById((reuse.body as ProfileImportResult).profile.id)!.variants![0]!.scriptId, 11);
  assert.equal(creates.length, 0);

  const create = await post("/api/profiles/import", { file, choices: { 0: "create" } });
  assert.equal(create.status, 200);
  assert.deepEqual(creates, [{ scriptId: 13, name: "Londinium Single 2" }]);
  assert.equal(machine.get(11)!.Content, "1;13;4 8000 1000;12 25000;7;", "das vorhandene Skript bleibt unverändert");
});

test("Zwei Varianten mit demselben neuen Skript → einmal angelegt", async () => {
  creates.length = 0;
  const res = await post("/api/profiles/import", { file: scriptFile("Doppelt", "1;13;4 6500 1000;12 28000;7;", true) });
  assert.equal(res.status, 200);
  assert.equal(creates.length, 1);
  const [a, b] = profiles.findById((res.body as ProfileImportResult).profile.id)!.variants!;
  assert.equal(a!.scriptId, b!.scriptId);
});

test("Fehler in der Datei → schon die Vorschau meldet ihn, nichts wird angelegt", async () => {
  creates.length = 0;
  const before = profiles.listAll().length;
  const bad = structuredClone(appFile);
  (bad.profile.variants[0]!.brewSteps as unknown as { steps: unknown[] }).steps = [{ kind: "rakete" }];
  const preview = await post("/api/profiles/import/preview", { file: bad });
  assert.equal(preview.status, 400);
  const res = await post("/api/profiles/import", { file: bad });
  assert.equal(res.status, 400);

  const badScript = scriptFile("Kaputt", "das ist kein Skript");
  assert.equal((await post("/api/profiles/import", { file: badScript })).status, 400);
  assert.equal(creates.length, 0);
  assert.equal(profiles.listAll().length, before);
});

test("Während eines Bezugs: kein Import mit Skript, App-Profile gehen", async () => {
  brewing = true;
  (recorder as { activeShotId: number | null }).activeShotId = 99;
  const blocked = await post("/api/profiles/import", { file: scriptFile("Waehrend", "1;13;4 6000 1000;12 20000;7;") });
  assert.equal(blocked.status, 409);
  assert.equal((await post("/api/profiles/import", { file: appFile })).status, 200);
  brewing = false;
  (recorder as { activeShotId: number | null }).activeShotId = null;
});

test("Maschine antwortet nicht → Skript-Import bricht vor dem Schreiben ab", async () => {
  machineDown = true;
  const res = await post("/api/profiles/import/preview", { file: scriptFile("X", LONDINIUM) });
  assert.equal(res.status, 502);
  machineDown = false;
});

test("Hin und zurück: der Export des importierten Profils ist die Datei", async () => {
  const res = await post("/api/profiles/import", { file: scriptFile("Rundreise", "1;13;4 5500 1000;12 22000;7;") });
  const p = profiles.findById((res.body as ProfileImportResult).profile.id)!;
  const again = buildProfileFile(p, scripts.listAll(), baskets.listAll());
  assert.deepEqual(again.profile, { ...scriptFile("Rundreise", "1;13;4 5500 1000;12 22000;7;").profile, name: p.name });
});

test("Decent-Profil als Text: Vorschau mit Übersetzungsbericht, Import legt einen Versuch an (ohne Maschine)", async () => {
  const text = fs.readFileSync(path.resolve(import.meta.dirname, "../../shared/test/fixtures/decent/80s_espresso.tcl"), "utf8");
  machineDown = true;
  const preview = await post("/api/profiles/import/preview", { text });
  assert.equal(preview.status, 200);
  const pv = preview.body as import("../../shared/src/profile-file.js").ImportPreview;
  assert.equal(pv.name, "80's Espresso");
  assert.equal(pv.translation?.title, "80's Espresso");
  assert.ok(pv.translation!.rows.some((r) => /Preinfusion/.test(r.xenia ?? "")));
  assert.equal(pv.profile.variants[0]!.brewSteps!.steps[0]!.kind, "preinfusion");

  const res = await post("/api/profiles/import", { text, choices: {} });
  assert.equal(res.status, 200);
  const p = profiles.findById((res.body as ProfileImportResult).profile.id)!;
  assert.equal(p.isTrial, true);
  assert.equal(p.targetTempC, 80);
  assert.deepEqual(p.variants![0]!.brewSteps!.steps.map((s) => s.kind), ["preinfusion", "pressure", "pressure"]);
  machineDown = false;
});

test("Profil-Datei der App als Text geht denselben Weg wie als Objekt; Unsinn wird abgelehnt", async () => {
  const preview = await post("/api/profiles/import/preview", { text: JSON.stringify(appFile) });
  assert.equal(preview.status, 200);
  assert.equal((preview.body as { translation: unknown }).translation, null);
  const bad = await post("/api/profiles/import/preview", { text: "hallo welt" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /weder ein Decent-Profil/);
});

test("lang: \"en\" → Übersetzungsbericht, Notiz und Fehlermeldung englisch; ohne lang deutsch, danach wieder deutsch", async () => {
  const text = fs.readFileSync(path.resolve(import.meta.dirname, "../../shared/test/fixtures/decent/80s_espresso.tcl"), "utf8");
  machineDown = true;
  const preview = await post("/api/profiles/import/preview", { text, lang: "en" });
  assert.equal(preview.status, 200);
  const pv = preview.body as import("../../shared/src/profile-file.js").ImportPreview;
  assert.deepEqual(pv.translation!.rows.map((r) => r.name).slice(-2), ["Temperature", "Target"]);
  assert.equal(pv.translation!.rows[0]!.decent, "Flow 7.5 ml/s until 3.8 bar · at most 8 s");
  assert.match(pv.profile.notes!, /^From Decent “80's Espresso”/);
  const bad = await post("/api/profiles/import/preview", { text: "hallo welt", lang: "en" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /neither a Decent profile/);

  // Sprache gilt nur fuer die eine Anfrage; Unbekanntes zaehlt als deutsch.
  const de = await post("/api/profiles/import/preview", { text, lang: "fr" });
  assert.equal((de.body as typeof pv).translation!.rows[0]!.decent, "Fluss 7,5 ml/s bis 3,8 bar · höchstens 8 s");
  const { sharedLang } = await import("../../shared/src/shared-lang.js");
  assert.equal(sharedLang(), "de");

  const res = await post("/api/profiles/import", { text, choices: {}, lang: "en" });
  assert.equal(res.status, 200);
  assert.match(profiles.findById((res.body as ProfileImportResult).profile.id)!.notes!, /^From Decent/);
  machineDown = false;

  // Auch die Pruefung vor dem Anlegen (Skript-Pruefung aus shared/) spricht englisch.
  const noStart = await post("/api/profiles/import/preview", { file: scriptFile("Ohne Start", "13;4 9000 1000;12 30000;7;"), lang: "en" });
  assert.equal(noStart.status, 400);
  assert.match(noStart.body.error, /The script must begin with Cmd 1/);
});
