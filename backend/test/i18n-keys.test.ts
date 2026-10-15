/**
 * i18n-Waechter: kein Schluessel darf fehlen, keine Sprache zurueckbleiben.
 *
 * Anlass: `coffee.less` war nur benutzt, nie definiert. t() gibt bei einem
 * unbekannten Schluessel den Schluessel SELBST zurueck — auf dem Tablet stand
 * dann woertlich "coffee.less". Der Fehler ist unsichtbar, bis jemand die
 * Stelle im Betrieb aufmacht; genau dafuer ist ein Test da.
 *
 * Grenze, bewusst: dynamisch gebaute Schluessel (`beans.roastLevel.${x}`)
 * sieht dieser statische Scan nicht. Er faengt die Tippfehler und die
 * Vergesslichkeit, nicht jeden denkbaren Fall.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { de } from "../../frontend/src/i18n/de.js";
import { en } from "../../frontend/src/i18n/en.js";

const FRONTEND_SRC = path.resolve(fileURLToPath(import.meta.url), "../../../frontend/src");

/** "a.b.c" fuer jedes Blatt des Uebersetzungsbaums. */
function flatten(o: unknown, prefix = ""): string[] {
  if (typeof o !== "object" || o === null) return [prefix];
  return Object.entries(o).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !p.includes(`${path.sep}i18n${path.sep}`) ? [p] : [];
  });
}

/**
 * Aufrufe von t("…") einsammeln.
 *
 * Der Lookbehind ist noetig, sonst zaehlt jede Funktion mit, deren Name auf
 * "t" endet — `numDefaultHint("chart_x_window_s")` sah sonst aus wie ein
 * Uebersetzungsschluessel.
 */
function usedKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(FRONTEND_SRC)) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?<![\w$.])t\(\s*"([^"]+)"/g)) {
      const key = m[1]!;
      const where = path.relative(FRONTEND_SRC, file);
      const list = found.get(key);
      if (list) { if (!list.includes(where)) list.push(where); } else { found.set(key, [where]); }
    }
  }
  return found;
}

test("de und en definieren dieselben Schluessel", () => {
  const dk = new Set(flatten(de));
  const ek = new Set(flatten(en));
  const onlyDe = [...dk].filter((k) => !ek.has(k)).sort();
  const onlyEn = [...ek].filter((k) => !dk.has(k)).sort();
  assert.deepEqual(onlyDe, [], `nur in de.ts: ${onlyDe.join(", ")}`);
  assert.deepEqual(onlyEn, [], `nur in en.ts: ${onlyEn.join(", ")}`);
  assert.ok(dk.size > 400, `unerwartet wenige Schluessel (${dk.size}) — Parser kaputt?`);
});

test("jeder benutzte Schluessel ist in beiden Sprachen definiert", () => {
  const dk = new Set(flatten(de));
  const ek = new Set(flatten(en));
  const missing: string[] = [];
  for (const [key, files] of usedKeys()) {
    if (!dk.has(key) || !ek.has(key)) {
      missing.push(`${key} (${!dk.has(key) ? "de" : ""}${!dk.has(key) && !ek.has(key) ? "+" : ""}${!ek.has(key) ? "en" : ""}) in ${files.join(", ")}`);
    }
  }
  assert.deepEqual(missing, [], `fehlende Uebersetzungen:\n  ${missing.join("\n  ")}`);
});

test("der Scanner findet ueberhaupt Aufrufe und faellt nicht auf Namen wie numDefaultHint herein", () => {
  const keys = usedKeys();
  assert.ok(keys.size > 200, `nur ${keys.size} Aufrufe gefunden — Regex kaputt?`);
  assert.ok(!keys.has("chart_x_window_s"), "Lookbehind greift nicht: Funktionsnamen auf -t werden mitgezaehlt");
});
