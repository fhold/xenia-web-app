/**
 * Farbschemata (Einstellungen → Oberfläche): Prüfung der gespeicherten
 * Schemata und die Zusage, dass Dunkel ohne eigene Farben exakt die alten
 * Werte liefert (sonst wäre die Oberfläche nicht mehr pixelgleich).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkColorSchemes, parseColorSchemes, UI_THEME_PATTERN, MAX_SCHEMES } from "../../shared/src/color-scheme.js";
import { buildTheme, PALETTES, contrast } from "../../frontend/src/theme.js";

const ok = { id: "abend", name: "Abend", base: "dark", colors: { acc: "#C08A3E", bg: "#101010" } };

test("checkColorSchemes: gültige Liste geht durch", () => {
  assert.equal(checkColorSchemes(JSON.stringify([ok])), null);
  assert.equal(checkColorSchemes("[]"), null);
  assert.deepEqual(parseColorSchemes(JSON.stringify([ok])), [ok]);
});

test("checkColorSchemes: lehnt Unbrauchbares ab", () => {
  const bad = (x: unknown) => assert.notEqual(checkColorSchemes(JSON.stringify(x)), null, JSON.stringify(x));
  assert.notEqual(checkColorSchemes("{kaputt"), null);
  bad({});
  bad([{ ...ok, id: "Groß" }]);
  bad([ok, ok]);
  bad([{ ...ok, name: "  " }]);
  bad([{ ...ok, base: "sepia" }]);
  bad([{ ...ok, colors: { acc: "red" } }]);
  bad([{ ...ok, colors: { cardHover: "#000000" } }]);
  bad(Array.from({ length: MAX_SCHEMES + 1 }, (_, i) => ({ ...ok, id: `s${i}` })));
  assert.deepEqual(parseColorSchemes("{kaputt"), []);
  assert.deepEqual(parseColorSchemes(undefined), []);
});

test("UI_THEME_PATTERN", () => {
  for (const v of ["dark", "light", "system", "scheme:abend"]) assert.ok(UI_THEME_PATTERN.test(v), v);
  for (const v of ["", "blue", "scheme:", "scheme:Abend"]) assert.ok(!UI_THEME_PATTERN.test(v), v);
});

test("buildTheme ohne eigene Farben = Palette unverändert", () => {
  assert.deepEqual(buildTheme("dark", {}), PALETTES.dark);
  assert.deepEqual(buildTheme("light", {}), PALETTES.light);
});

test("buildTheme: Abstufungen folgen der geänderten Grundfarbe", () => {
  const t = buildTheme("dark", { acc: "#C08A3E" });
  assert.equal(t.acc, "#C08A3E");
  assert.notEqual(t.accG, PALETTES.dark.accG);
  assert.notEqual(t.accTop, PALETTES.dark.accTop);
  // Nicht betroffene Abstufungen bleiben, wie sie sind.
  assert.equal(t.cardHover, PALETTES.dark.cardHover);
  // Schrift auf dem Akzent: die besser lesbare von dunkel und weiß.
  assert.ok(contrast(t.acc, t.onAcc) >= 4.5);
});

test("Hell: Text gut lesbar", () => {
  const l = PALETTES.light;
  assert.ok(contrast(l.txt, l.bg) >= 7);
  assert.ok(contrast(l.mut, l.card) >= 4.5);
  assert.ok(contrast(l.onAcc, l.acc) >= 4.5);
});
