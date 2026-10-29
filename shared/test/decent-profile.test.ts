/**
 * Decent → Xenia (2026-10-20): Uebersetzung nach festen Regeln, an echten
 * de1app-Profilen (fixtures/decent, aus decentespresso/de1app, GPL-3.0) und an
 * kleinen Beispielen fuer die Sonderfaelle (Hold-, Hebel-, Leistungsmodus,
 * Leiter, „Fluss über“).
 * Runner: node:test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTclList, translateDecent, type TranslationRow } from "../src/decent-profile.js";
import { validateBrewProfile } from "../src/brew-steps.js";
import type { BrewStep } from "../src/types.js";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "decent");
const file = (name: string) => readFileSync(resolve(dir, name), "utf8");

function ok(text: string) {
  const r = translateDecent(text);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return { ...r, steps: r.profile.variants[0]!.brewSteps!.steps, yieldG: r.profile.variants[0]!.yieldG };
}
/** Die Zeile zu einem Decent-Schritt (bzw. „Temperatur“ / „Ziel“). */
const rowOf = (rows: TranslationRow[], name: string | RegExp) => {
  const r = rows.find((x) => (typeof name === "string" ? x.name === name : name.test(x.name)));
  assert.ok(r, `keine Zeile ${name}: ${rows.map((x) => x.name).join(" | ")}`);
  return r!;
};
const hasHint = (hints: { text: string }[], re: RegExp) =>
  assert.ok(hints.some((h) => re.test(h.text)), `kein Hinweis ${re}: ${hints.map((h) => h.text).join(" | ")}`);

/** Die Beschreibung (profile_notes) einer Tcl-Datei. */
const tclNotes = (text: string) => { const w = parseTclList(text); return w[w.indexOf("profile_notes") + 1]!; };

/** Ein Advanced-Profil als Tcl, Schritte als key-value-Listen. */
const tcl = (steps: string[], extra = "") =>
  `advanced_shot {${steps.map((s) => `{${s}}`).join(" ")}}\nprofile_title {Test}\nsettings_profile_type settings_2c\nfinal_desired_shot_weight_advanced 36\n${extra}`;

test("Tcl-Listen: Woerter, verschachtelte {…}, \"…\" und Escapes", () => {
  assert.deepEqual(parseTclList(`a {b {c d}} "e f" g\\ h {}`), ["a", "b {c d}", "e f", "g h", ""]);
});

test("80's Espresso: Füllen → Preinfusion (Deckel 25 s), Halten mit Rampe, Abstieg gleitend; eine Temperatur", () => {
  const r = ok(file("80s_espresso.tcl"));
  assert.deepEqual(r.steps, [
    { kind: "preinfusion", name: "preinfusion", gentleness: "normal", fill: "fast", exit: { pressureBar: 3.8, seconds: 25 } },
    { kind: "pressure", name: "rise and hold", targetPressureBar: 7.8, rampMs: 3000, exit: { seconds: 4 } },
    { kind: "pressure", name: "decline", targetPressureBar: 5, rampMs: 50000, exit: {} },
  ] satisfies BrewStep[]);
  assert.equal(r.profile.name, "80's Espresso");
  assert.equal(r.profile.targetTempC, 80);
  assert.equal(r.yieldG, 36);
  assert.equal(r.profile.isTrial, true);
  assert.match(r.profile.notes!, /^Aus Decent „80's Espresso“ \(Decent\)\n\nFor medium to dark roasted beans\./);
  assert.deepEqual(r.rows.map((x) => [x.group, x.name, x.decent, x.xenia, x.status]), [
    ["step", "preinfusion start + preinfusion", "Fluss 7,5 ml/s bis 3,8 bar · höchstens 8 s", "Preinfusion · volle Pumpe ~5,6 ml/s, ab 1 bar 2 ml/s · bis 3,8 bar · höchstens 25 s", "changed"],
    ["step", "rise and hold", "Druck 7,8 bar · 4 s", "Druck 7,8 bar · Rampe 3 s · 4 s", "changed"],
    ["step", "decline", "Druck gleitend auf 5 bar · 50 s", "Druck gleitend auf 5 bar · bis 36 g", "same"],
    ["profile", "Temperatur", "82 → 80 → 72 °C", "80 °C (aus „rise and hold“)", "changed"],
    ["profile", "Ziel", "36 g", "36 g", "same"],
  ]);
  assert.match(rowOf(r.rows, "rise and hold").why!, /Rampe 3 s statt Sprung/);
  assert.match(rowOf(r.rows, "Temperatur").why!, /eine Temperatur pro Bezug/);
});

test("Dasselbe Profil als v2-JSON (de1app/visualizer) ergibt dieselbe Übersetzung", () => {
  const json = JSON.stringify({
    title: "80's Espresso", author: "Decent", beverage_type: "espresso", target_weight: "36", version: "2", notes: tclNotes(file("80s_espresso.tcl")),
    steps: [
      { name: "preinfusion start", temperature: "82.0", sensor: "coffee", pump: "flow", transition: "fast", pressure: "1", flow: "7.5", seconds: "2", volume: "0", weight: "0", limiter: { value: "0", range: "0.6" } },
      { name: "preinfusion", temperature: "82.0", sensor: "coffee", pump: "flow", transition: "fast", pressure: "1", flow: "7.5", seconds: "6", volume: "0", weight: "0", exit: { type: "pressure", condition: "over", value: "3.8" }, limiter: { value: "0", range: "0.6" } },
      { name: "rise and hold", temperature: "80.0", sensor: "coffee", pump: "pressure", transition: "fast", pressure: "7.8", flow: "", seconds: "4.00", volume: "0", weight: "0", limiter: { value: "0", range: "0.6" } },
      { name: "decline", temperature: "72.0", sensor: "coffee", pump: "pressure", transition: "smooth", pressure: "5.0", flow: "", seconds: "50.00", volume: "0", weight: "0", limiter: { value: "0", range: "0.6" } },
    ],
  });
  const a = ok(json);
  const b = ok(file("80s_espresso.tcl"));
  assert.deepEqual(a.profile, b.profile);
  assert.deepEqual(a.rows, b.rows);
  assert.deepEqual(a.hints, b.hints);
  // visualizer.coffee: Bezug mit dem Profil unter „profile“
  assert.deepEqual(ok(JSON.stringify({ id: "x", profile: JSON.parse(json) })).profile, b.profile);
});

test("Einfaches Druckprofil (settings_2a): Schritte wie die de1app sie erzeugt", () => {
  const r = ok(file("default.tcl"));
  assert.deepEqual(r.steps.map((s) => [s.kind, s.name, s.exit.seconds ?? null]), [
    ["preinfusion", "preinfusion", 25],
    ["pressure", "forced rise", 3],
    ["pressure", "rise and hold", 1],
    ["pressure", "forced rise", 3],
    ["pressure", "decline", null],
  ]);
});

test("Einfaches Flussprofil (settings_2b): beide Füllschritte (Temperatur-Boost) werden eine Preinfusion", () => {
  const r = ok(file("gentle_flat_2.5.tcl"));
  assert.deepEqual(r.steps.map((s) => s.kind), ["preinfusion", "flow"]);
  assert.equal((r.steps[1] as { targetFlowGs: number }).targetFlowGs, 2.5);
  assert.equal(rowOf(r.rows, "preinfusion boost + preinfusion").status, "changed");
  assert.equal(rowOf(r.rows, "decline").status, "dropped");
  hasHint(r.hints, /Fluss-Sollwerte sind Startwerte/);
});

test("TurboBloom: Fluss 0 = Pumpe aus mit „Ende unter 2,2 bar“; Ausstieg „unter 0“ fällt weg", () => {
  const r = ok(file("turbobloom.tcl"));
  assert.deepEqual(r.steps[1], { kind: "power", name: "dynamic bloom", power: 0, exit: { seconds: 40, pressureBelowBar: 2.2 } });
  assert.match(rowOf(r.rows, "6 bar").why!, /Fluss unter 0“ greift nie/);
  const bloom = rowOf(r.rows, "dynamic bloom");
  assert.equal(bloom.xenia, "Pause (Pumpe aus) · bis unter 2,2 bar · höchstens 40 s");
  assert.match(bloom.why!, /einmal darüber lag/);
});

test("V60: Benetzen nach der Uhr vor dem Bloom → Preinfusion 8 s (kein 25-s-Deckel), Pausen, Ziel aus dem Titel", () => {
  const r = ok(file("v60_15g.tcl"));
  assert.deepEqual(r.steps[0], { kind: "preinfusion", name: "preinfusion", gentleness: "normal", fill: "fast", exit: { seconds: 8 } });
  assert.match(rowOf(r.rows, "preinfusion").why!, /mit voller Pumpe \(~5,6 ml\/s statt 8\)/);
  assert.deepEqual(r.steps.map((s) => s.kind), ["preinfusion", "power", "flow", "power", "flow", "power", "flow"]);
  // „V60 15g in, 250g out“ — nicht Fluss × Zeit (344 ml Wasser in den Kaffee)
  assert.equal(r.yieldG, 250);
  const ziel = rowOf(r.rows, "Ziel");
  assert.deepEqual([ziel.decent, ziel.xenia], ["keins (im Titel „250g out“)", "250 g"]);
  assert.equal(r.hints.filter((h) => /schafft die Pumpe nicht/.test(h.text)).length, 1, "Pumpendecke nur einmal melden");
});

test("Adaptive v3: Null-Schritt vor einer Rampe fällt weg — mit Begründung zur Rampe", () => {
  const r = ok(file("adaptive_v3.tcl"));
  const n = rowOf(r.rows, "Extraction start");
  assert.equal(n.status, "dropped");
  assert.match(n.why!, /Startwert der folgenden Rampe/);
  assert.deepEqual(r.steps.at(-1), { kind: "flow", name: "Extraction", targetFlowGs: 3.5, rampMs: 60000, exit: {}, maxPressureBar: 8.6 });
});

test("Advanced spring lever: „Druck unter“ wird übernommen, mit Hinweis aufs Scharfschalten", () => {
  const r = ok(file("advanced_spring_lever.tcl"));
  assert.ok(r.steps.some((s) => s.exit.pressureBelowBar === 6));
  assert.ok(r.rows.some((x) => x.status === "changed" && /einmal darüber lag/.test(x.why ?? "")));
});

test("Reinigungsprofil wird mit Begründung abgelehnt; Gaggiuino und Fremdes ebenso", () => {
  const c = translateDecent(file("cleaning_forward_flush.tcl"));
  assert.equal(c.ok, false);
  assert.match((c as { error: string }).error, /Reinigungs/);
  const g = translateDecent(JSON.stringify({ id: 31, name: "Adaptive Light Roast v2", phases: [] }));
  assert.match((g as { error: string }).error, /Gaggiuino/);
  assert.match((translateDecent("hallo welt") as { error: string }).error, /weder ein Decent-Profil/);
});

test("Alle Fixtures übersetzen zu gültigen App-Stufen", () => {
  for (const f of readdirSync(dir)) {
    const r = translateDecent(file(f));
    if (!r.ok) continue;
    const v = validateBrewProfile(r.profile.variants[0]!.brewSteps);
    assert.ok(v.ok, `${f}: ${v.ok ? "" : v.error}`);
  }
});

// --- Sonderfaelle ---------------------------------------------------------------

const fill = "name Fill pump flow flow 6 transition fast seconds 10 exit_if 1 exit_type pressure_over exit_pressure_over 4 temperature 92";

test("HOLD-Fluss → „Fluss vom Puck übernehmen“, HOLD-Druck → „Druck vom Puck übernehmen“", () => {
  const r = ok(tcl([
    fill,
    "name Peak pump pressure pressure 9 transition fast seconds 6 temperature 92",
    "name {Hold P} pump pressure pressure 8 transition hold seconds 5 temperature 92",
    "name {Hold F} pump_mode HOLD-F pump pressure flow 1.5 seconds 30 temperature 92",
  ]));
  assert.equal((r.steps[2] as { adoptPressure?: boolean }).adoptPressure, true);
  assert.equal((r.steps[3] as { adoptFlow?: boolean }).adoptFlow, true);
  assert.equal(r.steps[3]!.kind, "flow");
  assert.match(rowOf(r.rows, "Hold F").xenia!, /^Fluss vom Puck übernehmen/);
  assert.match(rowOf(r.rows, "Hold P").xenia!, /^Druck vom Puck übernehmen/);
  assert.equal(rowOf(r.rows, "Hold F").status, "same");
});

test("Hebel- und Leistungsmodus: Druckstufe als Annäherung, deutlich gemeldet", () => {
  const r = ok(tcl([
    fill,
    "name Spring pump lever pressure 9 lever_spring 1.2 seconds 20 temperature 92",
    "name Watts pump power power 2.5 mode_max_pressure 8.5 seconds 20 temperature 92",
  ]));
  assert.deepEqual(r.steps.slice(1).map((s) => [s.kind, (s as { targetPressureBar: number }).targetPressureBar]), [["pressure", 9], ["pressure", 8.5]]);
  assert.deepEqual([rowOf(r.rows, "Spring").status, rowOf(r.rows, "Spring").xenia], ["approx", "Druck 9 bar · 20 s"]);
  assert.deepEqual([rowOf(r.rows, "Watts").status, rowOf(r.rows, "Watts").decent], ["approx", "Leistungsregelung · 20 s"]);
  assert.match(rowOf(r.rows, "Spring").why!, /Federhebel/);
});

test("„Fluss über“ wird übernommen; Leiter aus Flussstufen wird als Decent-Kniff gemeldet", () => {
  const r = ok(tcl([
    fill,
    "name Soak pump pressure pressure 3 seconds 20 exit_if 1 exit_type flow_over exit_flow_over 1.2 temperature 92",
    ...[2.0, 1.8, 1.6, 1.4].map((f) => `name {Scan ${f}} pump flow flow ${f} seconds 30 exit_if 1 exit_type flow_under exit_flow_under ${f - 0.1} temperature 92`),
    "name Last pump flow flow 1.2 seconds 60 temperature 92",
  ]));
  assert.equal(r.steps[1]!.exit.flowAboveGs, 1.2);
  hasHint(r.hints, /Leiter aus Flussstufen/);
});

test("Wassermenge unter 100 ml wird gemeldet, Sicherheitsnetze ab 100 ml nicht", () => {
  const r = ok(tcl([
    fill,
    "name Push pump pressure pressure 9 seconds 20 volume 40 temperature 92",
    "name Hold pump pressure pressure 9 seconds 20 volume 100 temperature 92",
    "name End pump flow flow 1.5 seconds 30 temperature 92",
  ]));
  assert.equal(rowOf(r.rows, "Push").status, "changed");
  assert.match(rowOf(r.rows, "Push").why!, /40 ml entfällt/);
  assert.equal(rowOf(r.rows, "Hold").status, "same");
});

test("Ziel aus dem Titel auch in ml; ohne jede Angabe kein Ziel — die letzte Stufe behält ihre Zeit und beendet den Bezug", () => {
  assert.equal(ok(tcl([fill, "name End pump flow flow 2 seconds 60 temperature 92"]).replace("profile_title {Test}", "profile_title {Pour over basket/Kalita 20g in, 340ml out}").replace("final_desired_shot_weight_advanced 36", "")).yieldG, 340);
  const none = ok(tcl([fill, "name End pump flow flow 2 seconds 60 temperature 92"]).replace("final_desired_shot_weight_advanced 36", ""));
  assert.equal(none.yieldG, null);
  assert.deepEqual(none.steps.at(-1)!.exit, { seconds: 60 });
  assert.equal(rowOf(none.rows, "Ziel").xenia, "keins — endet mit der letzten Stufe");
  assert.equal(rowOf(none.rows, "End").xenia, "Fluss 2 g/s · 60 s");
  // mit Ziel zaehlen die Ausstiege der letzten Stufe nicht (die Waage stoppt)
  assert.deepEqual(ok(tcl([fill, "name End pump flow flow 2 seconds 60 temperature 92"])).steps.at(-1)!.exit, {});
});

test("Rampe nach dem Füllen nur bei einem Sprung nach oben, nicht beim Abfall (Tee: 0,1 bar)", () => {
  const r = ok(tcl([fill, "name Infuse pump pressure pressure 0.1 seconds 20 temperature 92", "name Push pump pressure pressure 6 seconds 10 temperature 92"]));
  assert.equal((r.steps[1] as { rampMs?: number }).rampMs, undefined);
  assert.equal(rowOf(r.rows, "Infuse").status, "same");
});

// --- Korrekturen nach den Messläufen (23.10.) -----------------------------------

test("Druck-Füllung (Ziel über dem eigenen Ausstieg) → Preinfusion mit voller Pumpe, Vorlauf zählt mit; Temperatur der Stufe danach", () => {
  // Damian's Q / LRv3: „6 bar bis 3 bar“ fährt die Decent mit voller Pumpe (IgnoreLimit); danach Fluss → ab 1 bar zügig
  const r = ok(tcl([
    "name {Fill start} pump pressure pressure 6 seconds 2 temperature 84",
    "name Filling pump pressure pressure 6 seconds 25 exit_if 1 exit_type pressure_over exit_pressure_over 3 temperature 84",
    "name Pouring pump flow flow 1.8 seconds 60 temperature 94",
  ]));
  assert.deepEqual(r.steps[0], { kind: "preinfusion", name: "Filling", gentleness: "normal", fill: "fast", exit: { pressureBar: 3, seconds: 27 } });
  assert.equal(r.steps[1]!.kind, "flow");
  const row = rowOf(r.rows, "Fill start + Filling");
  assert.equal(row.decent, "Druck 6 bar · bis 3 bar · höchstens 25 s");
  assert.match(row.xenia!, /^Preinfusion · volle Pumpe ~5,6 ml\/s, ab 1 bar 2 ml\/s · bis 3 bar/);
  assert.match(row.why!, /\(#158\/#159\) — daher als Preinfusion\.\nAb 1 bar gebremst: Auf der Decent steigt der Druck beim Füllen nur um 0,4–1 bar\/s/);
  assert.equal(r.profile.targetTempC, 94);
});

test("Langsame Fluss-Füllung (unter 3 ml/s) → tränken mit der Stufe nächst Decents Rate, mit Begründung", () => {
  const slow = (mls: number) => ok(tcl([
    `name Fill pump flow flow ${mls} transition fast seconds 30 exit_if 1 exit_type pressure_over exit_pressure_over 2 temperature 92`,
    "name Hold pump flow flow 2.5 seconds 25 temperature 92",
  ]));
  const r = slow(1.5);
  assert.equal((r.steps[0] as { gentleness?: string }).gentleness, "gentle");
  assert.equal((r.steps[0] as { fill?: string }).fill, undefined);
  assert.match(rowOf(r.rows, "Fill").why!, /\nSo langsam fördert die Pumpe ohne Gegendruck nicht zuverlässig \(unter 25 % gar nicht, ab 25 % rund 2 ml\/s\) — daher bis 1 bar 3,5 ml\/s\.$/);
  assert.equal(rowOf(r.rows, "Fill").xenia, "Preinfusion · 3,5 ml/s, ab 1 bar 1,5 ml/s · bis 2 bar · höchstens 30 s");
  assert.equal((slow(2).steps[0] as { gentleness?: string }).gentleness, "normal");
  assert.equal((slow(2.4).steps[0] as { gentleness?: string }).gentleness, "brisk");
  assert.match(rowOf(slow(2.4).rows, "Fill").xenia!, /ab 1 bar 2,5 ml\/s/);
  // 6 ml/s bremst ab 1 bar mit „normal“, auch wenn der Druck danach weit steigt
  assert.equal((ok(tcl([fill, "name Rise pump pressure pressure 9 seconds 25 temperature 92"])).steps[0] as { gentleness?: string }).gentleness, "normal");
});

test("Schnelle Fluss-Füllung (näher an voller Pumpe als an 3,5 ml/s) → volle Pumpe, ab 1 bar gebremst; bis 4,5 ml/s mit 3,5 ml/s", () => {
  const withFill = (mls: number) => ok(tcl([
    `name Fill pump flow flow ${mls} transition fast seconds 10 exit_if 1 exit_type pressure_over exit_pressure_over 4 temperature 92`,
    "name Rise pump pressure pressure 9 seconds 25 temperature 92",
  ]));
  const first = (mls: number) => withFill(mls).steps[0] as { fill?: string; gentleness?: string };
  assert.deepEqual([first(8).fill, first(8).gentleness], ["fast", "normal"]);
  assert.equal(first(5).fill, "fast");
  assert.deepEqual([first(4.5).fill, first(4.5).gentleness], [undefined, "normal"]);
  assert.deepEqual([first(4).fill, first(4).gentleness], [undefined, "normal"]);
  assert.match(rowOf(withFill(8).rows, "Fill").why!, /\nMehr als ~5,6 ml\/s fördert die Pumpe nicht\.\n/);
  assert.equal(rowOf(withFill(8).rows, "Fill").xenia, "Preinfusion · volle Pumpe ~5,6 ml/s, ab 1 bar 2 ml/s · bis 4 bar · höchstens 25 s");
  assert.doesNotMatch(rowOf(withFill(4).rows, "Fill").why!, /schnell/);
  assert.match(rowOf(withFill(4).rows, "Fill").why!, /\nDie Preinfusion füllt mit 3,5 ml\/s oder voller Pumpe — 3,5 liegt näher an Decents 4 ml\/s\.\n/);
  assert.equal(rowOf(withFill(4).rows, "Fill").xenia, "Preinfusion · 3,5 ml/s, ab 1 bar 2 ml/s · bis 4 bar · höchstens 25 s");
});

test("Schnelle Füllung bremst ab 1 bar („normal“), egal was danach kommt — so steigt der Druck wie auf der Decent", () => {
  const after = (next: string, exitBar = 4) => ok(tcl([
    `name Fill pump flow flow 8 transition fast seconds 10 exit_if 1 exit_type pressure_over exit_pressure_over ${exitBar} temperature 92`,
    next,
  ]));
  const soak = (next: string, exitBar?: number) => (after(next, exitBar).steps[0] as { gentleness?: string }).gentleness;
  for (const next of [
    "name Rise pump pressure pressure 8 seconds 25 temperature 92",
    "name Bloom pump flow flow 0 seconds 10 temperature 92",
    "name Infuse pump pressure pressure 4 seconds 10 temperature 92",
    "name Pour pump flow flow 2 seconds 25 temperature 92",
  ]) assert.equal(soak(next), "normal", next);
  const row = rowOf(after("name Infuse pump pressure pressure 4 seconds 10 temperature 92").rows, "Fill");
  assert.equal(row.xenia, "Preinfusion · volle Pumpe ~5,6 ml/s, ab 1 bar 2 ml/s · bis 4 bar · höchstens 25 s");
  assert.match(row.why!, /\nAb 1 bar gebremst: Auf der Decent steigt der Druck beim Füllen nur um 0,4–1 bar\/s, weil der Puck noch Wasser aufnimmt\. Bei uns tropft es dann schon — ungebremst bis 4 bar spränge der Druck\.\nHöchstens 25 statt 10 s: Das Füllen dauert hier länger \(bis 3,8 bar 6–9 s\), die Zeit ist nur ein Schutz\.$/);
  assert.doesNotMatch(row.why!, /„keine“/);
  // Ausstieg bei 1 bar: dort gibt es nichts zu bremsen, also auch keinen Satz dazu
  assert.doesNotMatch(rowOf(after("name Infuse pump pressure pressure 3 seconds 10 temperature 92", 1).rows, "Fill").why!, /gebremst/);
});

test("Gleitend auf 0: ab 5 s Druck- bzw. Flussrampe statt Pumpe aus; 1 s am Ende bleibt Pumpe aus", () => {
  const r = ok(tcl([
    fill,
    "name Peak pump pressure pressure 9 seconds 8 temperature 92",
    "name Decline pump pressure pressure 0 transition smooth seconds 27 temperature 92",
  ]));
  assert.deepEqual(r.steps[2], { kind: "pressure", name: "Decline", targetPressureBar: 0.1, rampMs: 27000, exit: {} });
  assert.match(rowOf(r.rows, "Decline").why!, /#284/);
  const f = ok(tcl([
    fill,
    "name Extract pump flow flow 0 transition smooth seconds 60 max_flow_or_pressure 9 temperature 92",
  ]));
  assert.deepEqual(f.steps[1], { kind: "flow", name: "Extract", targetFlowGs: 0.5, rampMs: 60000, exit: {}, maxPressureBar: 9 });
  const end = ok(tcl([
    fill,
    "name Main pump pressure pressure 9 seconds 20 temperature 92",
    "name Reset pump flow flow 0 transition smooth seconds 1 temperature 92",
  ]));
  assert.deepEqual([end.steps[2]!.kind, (end.steps[2] as { power?: number }).power], ["power", 0]);
  assert.equal(rowOf(end.rows, "Reset").status, "changed");
});

test("Fluss unter 0,5 ml/s → Pumpe aus (Annäherung); 0,5 ml/s bleibt eine Flussstufe", () => {
  const r = ok(tcl([
    fill,
    "name Bloom pump flow flow 0.1 seconds 30 temperature 92",
    "name {Last resort} pump flow flow 0.5 seconds 60 temperature 92",
    "name Push pump flow flow 2 seconds 30 temperature 92",
  ]));
  assert.deepEqual([r.steps[1]!.kind, (r.steps[1] as { power?: number }).power, r.steps[1]!.exit], ["power", 0, { seconds: 30 }]);
  assert.equal(rowOf(r.rows, "Bloom").status, "approx");
  assert.deepEqual([r.steps[2]!.kind, (r.steps[2] as { targetFlowGs?: number }).targetFlowGs], ["flow", 0.5]);
});

test("Einordnung beim Import: Filter aus der Getränkeart, hell/dunkel aus dem Namen, sonst leer", async () => {
  const { decentFit } = await import("../src/decent-profile.js");
  assert.deepEqual(decentFit("pourover", "Kalita 20g"), ["filter"]);
  assert.deepEqual(decentFit("filter", "Filter 2.1"), ["filter"]);
  assert.deepEqual(decentFit("espresso", "A-Flow / default-dark"), ["dark"]);
  assert.deepEqual(decentFit("espresso", "EspressoForge_Light"), ["light"]);
  assert.deepEqual(decentFit("espresso", "Adaptive for Light Roast v3"), ["light"]);
  assert.deepEqual(decentFit("espresso", "Londonium"), []);
  assert.deepEqual(decentFit("espresso", "Highlights"), []);
  assert.deepEqual(ok(tcl([fill, "name End pump flow flow 2 seconds 30 temperature 92"])).profile.fit, []);
});
