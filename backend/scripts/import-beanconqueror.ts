/**
 * Einmal-Import der Bohnen-Historie aus Beanconqueror.
 *
 *   npx tsx scripts/import-beanconqueror.ts <Beanconqueror.json> [--write]
 *
 * Ohne --write passiert nichts: es wird nur berichtet, was passieren wuerde.
 *
 * Modell-Unterschied, der die ganze Arbeit ausmacht: BC fuehrt eine Bohne als
 * EINEN Eintrag — Stammdaten und die konkrete Tuete in einem. Wir trennen in
 * `coffee` (Sorte) und `bean` (Roestung). Mehrere Kaeufe derselben Sorte
 * werden deshalb zu EINER Sorte mit mehreren Roestungen zusammengezogen,
 * verglichen ueber Name + Roesterei (Gross-/Kleinschreibung egal).
 *
 * Bewusst NICHT importiert: die Bezuege (BREWS). Sie sind voellig anders
 * aufgezeichnet worden; als Historie interessieren nur die Bohnen.
 */

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [, , file, ...flags] = process.argv;
const WRITE = flags.includes("--write");
if (!file) {
  console.error("Aufruf: tsx scripts/import-beanconqueror.ts <Beanconqueror.json> [--write]");
  process.exit(1);
}

const DB_PATH = process.env.DB_PATH ?? "/var/lib/xenia/xenia.db";

interface BcBean {
  name: string;
  roaster?: string | null;
  roastingDate?: string | null;
  weight?: number | null;
  cost?: number | null;
  roast?: string | null;
  rating?: number | null;
  aromatics?: string | null;
  note?: string | null;
  url?: string | null;
  finished?: boolean;
  frozenDate?: string | null;
  decaffeinated?: boolean;
  config?: { unix_timestamp?: number };
}

/** BC-Roestgrad → unser Enum. Was BC nicht weiss, bleibt leer statt geraten. */
const ROAST: Record<string, string | null> = {
  CINNAMON_ROAST: "light",
  AMERICAN_ROAST: "light",
  NEW_ENGLAND_ROAST: "light",
  HALF_CITY_ROAST: "light",
  CITY_ROAST: "light-medium",
  CITY_PLUS_ROAST: "medium",
  FULL_CITY_ROAST: "medium-dark",
  FULL_CITY_PLUS_ROAST: "medium-dark",
  VIENNA_ROAST: "dark",
  FRENCH_ROAST: "dark",
  ITALIAN_ROAST: "dark",
  UNKNOWN: null,
};

/** BC bewertet 0–5, wir mit Daumen. 0 heisst "nicht bewertet", nicht "schlecht". */
function rating(n: number | null | undefined): string | null {
  if (!n) return null;
  if (n <= 2) return "thumbs_down";
  if (n === 3) return "meh";
  return "thumbs_up";
}

const day = (iso: string | null | undefined): string | null => (iso ? iso.slice(0, 10) : null);

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON");

const beans = (JSON.parse(fs.readFileSync(file, "utf8")) as { BEANS: BcBean[] }).BEANS;

/** Was gar nicht erst importiert wird. */
const SKIP_NAMES = new Set(["testbohnen"]);

/** "Deepwood Espresso" -> "Deepwood". Nur der Suffix, nur wenn etwas uebrig bleibt. */
const stripEspresso = (n) => (/\s+espresso$/i.test(n) ? n.replace(/\s+espresso$/i, "").trim() : n);

// --- Gruppieren: (Name, Roesterei) case-insensitiv. "van Guelpen" und
//     "Van Guelpen" sind dieselbe Roesterei.
//
// Flavios Regel: wo dieselbe Sorte einmal mit und einmal ohne "Espresso" im
// Namen steht (Deepwood, Volta, Bullitt), ist das EINE Sorte und laeuft unter
// dem Namen ohne Suffix. Bewusst nur dort, wo beide Varianten wirklich
// vorkommen -- sonst wuerde aus "Coffeeman Espresso" ungefragt "Coffeeman".
// "Espresso" (van Guelpen) bleibt unangetastet: vor dem Suffix bliebe nichts.
const rawNames = new Set(
  beans.map((x) => `${(x.name ?? "").trim().toLowerCase()} ${(x.roaster ?? "").trim().toLowerCase()}`));

const groups = new Map();
const merges = [];
for (const b of beans) {
  const raw = (b.name ?? "").trim();
  const roaster = (b.roaster ?? "").trim();
  if (!raw || SKIP_NAMES.has(raw.toLowerCase())) continue;
  const base = stripEspresso(raw);
  const baseExists = base !== raw && rawNames.has(`${base.toLowerCase()} ${roaster.toLowerCase()}`);
  const name = baseExists ? base : raw;
  if (baseExists) {
    const line = `  "${raw}" -> "${base}" (${roaster})`;
    if (!merges.includes(line)) merges.push(line);
  }
  const key = `${name.toLowerCase()} ${roaster.toLowerCase()}`;
  const g = groups.get(key) ?? { name, roaster: roaster || null, items: [] };
  g.items.push(b);
  groups.set(key, g);
}

// --- Vorhandene Sorten und ihre Roestdaten
const existing = new Map<string, number>();
for (const r of db.prepare("SELECT id, name, roaster FROM coffee").all() as unknown as
     { id: number; name: string; roaster: string | null }[]) {
  existing.set(`${r.name.trim().toLowerCase()} ${(r.roaster ?? "").trim().toLowerCase()}`, r.id);
}
const datesOf = (coffeeId: number): Set<string> =>
  new Set((db.prepare("SELECT roast_date FROM bean WHERE coffee_id = ?").all(coffeeId) as unknown as
    { roast_date: string | null }[]).map((r) => r.roast_date ?? "").filter(Boolean));

let newCoffees = 0, matchedCoffees = 0, newRoastings = 0, skipped = 0;
const report: string[] = [];
const now = Date.now();

const insCoffee = db.prepare(
  `INSERT INTO coffee (name, roaster, roast_level, flavor_notes, notes, favourite, rating, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`);
const insBean = db.prepare(
  `INSERT INTO bean (coffee_id, roast_date, bag_size_g, remaining_g, price_per_bag_eur, status, is_active, frozen_date, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`);

if (WRITE) db.exec("BEGIN");

for (const g of [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  const roasterKey = (g.roaster ?? "").toLowerCase();
  // Auch der Suffix-Fall zaehlt als Treffer: BC kennt "Blackcap", bei uns heisst
  // dieselbe Sorte "Blackcap Espresso". Sonst stuende sie doppelt in der Liste.
  const hit = existing.get(`${g.name.toLowerCase()} ${roasterKey}`)
    ?? existing.get(`${g.name.toLowerCase()} espresso ${roasterKey}`)
    ?? existing.get(`${stripEspresso(g.name).toLowerCase()} ${roasterKey}`);

  // Stammdaten aus dem reichhaltigsten Eintrag der Gruppe.
  const best = [...g.items].sort((a, b) =>
    Number(!!b.aromatics) - Number(!!a.aromatics) || Number(!!b.note) - Number(!!a.note))[0]!;
  const notes = [
    best.note?.trim() || null,
    best.decaffeinated ? "Entkoffeiniert." : null,
    best.url?.trim() ? `Quelle: ${best.url.trim()}` : null,
  ].filter(Boolean).join(" ") || null;
  const flavors = best.aromatics
    ? JSON.stringify(best.aromatics.split(",").map((s) => s.trim()).filter(Boolean))
    : null;
  const roastLevel = ROAST[best.roast ?? "UNKNOWN"] ?? null;
  const best5 = Math.max(0, ...g.items.map((i) => i.rating ?? 0));

  let coffeeId: number;
  if (hit !== undefined) {
    coffeeId = hit;
    matchedCoffees++;
    report.push(`~ ${g.name} — ${g.roaster ?? "ohne Rösterei"}  (vorhandene Sorte #${hit})`);
  } else {
    newCoffees++;
    report.push(`+ ${g.name} — ${g.roaster ?? "ohne Rösterei"}  (neue Sorte)`);
    coffeeId = WRITE
      ? Number(insCoffee.run(g.name, g.roaster, roastLevel, flavors, notes, rating(best5), now, now).lastInsertRowid)
      : -1;
  }

  const taken = hit !== undefined ? datesOf(hit) : new Set<string>();
  for (const it of g.items) {
    const d = day(it.roastingDate);
    if (d && taken.has(d)) { skipped++; report.push(`    · ${d} übersprungen (Röstung mit diesem Datum gibt es schon)`); continue; }
    const status = it.frozenDate ? "frozen" : it.finished ? "archived" : "stock";
    const remaining = status === "archived" ? 0 : null;
    const created = it.config?.unix_timestamp ? it.config.unix_timestamp * 1000 : now;
    newRoastings++;
    report.push(`    + ${d ?? "ohne Datum"}  ${it.weight ?? "?"} g  ${it.cost ? `${it.cost} €` : "—"}  ${status}`);
    // 0 g / 0 € heisst in BC "nicht erfasst" — als 0 gespeichert waere es eine Behauptung.
    if (WRITE) insBean.run(coffeeId, d, it.weight || null, remaining, it.cost || null, status, day(it.frozenDate), created, now);
  }
}

if (WRITE) db.exec("COMMIT");

if (merges.length) console.log("Zusammengefuehrte Namensvarianten:\n" + merges.join("\n") + "\n");
console.log(report.join("\n"));
console.log("\n" + "=".repeat(70));
console.log(`${WRITE ? "GESCHRIEBEN" : "TROCKENLAUF — nichts geändert"}`);
console.log(`  BC-Einträge          : ${beans.length}`);
console.log(`  daraus Sorten        : ${groups.size}  (${newCoffees} neu, ${matchedCoffees} bereits vorhanden)`);
console.log(`  Röstungen angelegt   : ${newRoastings}`);
console.log(`  Röstungen übersprungen: ${skipped} (Datum schon vorhanden)`);
db.close();
