/**
 * Skriptansicht und Skript-Editor beschreiben dieselben Befehle — aus einer
 * Quelle (script-help: Titel und Felder). Anlass: die Ansicht hatte eine eigene,
 * fest verdrahtete Liste; Heizleistung Brühkessel/Brühgruppe standen dort ohne
 * Wert, der Signalton als rohe Zahlen, und die Namen wichen vom Editor ab.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeCmdLine } from "../src/script-timeline.js";
import { CMD_ARGS, CMD_HELP } from "../src/script-help.js";
import { parseScript } from "../src/script-parser.js";

const cmd = (s: string) => parseScript(`1;${s};7;`).commands[1];

test("jeder Befehl mit Feldern zeigt in der Ansicht alle Werte", () => {
  for (const id of Object.keys(CMD_ARGS).map(Number)) {
    const fields = CMD_ARGS[id];
    // eindeutige Rohwerte je Feld, damit ein fehlender Wert auffaellt
    const raw = fields.map((f, i) => (i + 2) * f.scale);
    const d = describeCmdLine(cmd(`${id} ${raw.join(" ")}`));
    for (let i = 0; i < fields.length; i++) {
      assert.ok(d.detail.includes(String(i + 2)), `Cmd ${id}: Wert ${i + 2} fehlt in "${d.detail}"`);
    }
  }
});

test("Namen wie im Editor", () => {
  for (const id of Object.keys(CMD_HELP).map(Number)) {
    assert.equal(describeCmdLine(cmd(String(id))).label, CMD_HELP[id].title, `Cmd ${id}`);
  }
});

test("Formate: Rampe, Heizleistung, Signalton, Komma", () => {
  assert.deepEqual(describeCmdLine(cmd("4 3800 2000")), { label: "Pumpendruck", detail: "3,8 bar in 2 s" });
  assert.deepEqual(describeCmdLine(cmd("9 0")), { label: "Heizleistung Brühgruppe", detail: "0 %" });
  assert.deepEqual(describeCmdLine(cmd("8 100")), { label: "Heizleistung Brühkessel", detail: "100 %" });
  assert.deepEqual(describeCmdLine(cmd("20 3 500")), { label: "Signalton", detail: "3 × 0,5 s" });
  assert.deepEqual(describeCmdLine(cmd("12 10000")), { label: "Warten", detail: "10 s" });
});

test("unbekannter Befehl: Nummer und rohe Argumente", () => {
  assert.deepEqual(describeCmdLine(cmd("99 1 2")), { label: "Cmd 99", detail: "1 2" });
});
