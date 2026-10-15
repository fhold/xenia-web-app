/**
 * Neue Skripte landen auf einer freien, in der Xenia-Oberflaeche sichtbaren Nummer.
 *
 * Anlass: ohne Nummer legte die Maschine Skripte ab 150 ab (150–152), obwohl
 * 21–24 frei waren. Dort zeigt die Xenia-Weboberflaeche sie nicht an. Und:
 * bestehende Skripte duerfen dabei nie ueberschrieben werden.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createScriptOnMachine, nextFreeScriptId, FIRST_SCRIPT_SLOT, INVISIBLE_FROM_SLOT,
} from "../src/xenia/script-sync.js";
import type { XeniaClient } from "../src/xenia/client.js";
import type { ScriptRepo } from "../src/db/script-repo.js";
import type { XeniaScript } from "../../shared/src/types.js";

// Belegung am 2026-09-26
const BELEGT = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 25, 26, 28, 29, 30, 31];

test("naechste freie Nummer: die kleinste Luecke ab 10", () => {
  assert.equal(nextFreeScriptId(BELEGT), 21);
  assert.equal(nextFreeScriptId([...BELEGT, 21, 22, 23, 24]), 27);
});

test("naechste freie Nummer: nie unter 10, nie im unsichtbaren Bereich ab 150", () => {
  assert.equal(nextFreeScriptId([]), FIRST_SCRIPT_SLOT);
  const allesVoll = Array.from({ length: INVISIBLE_FROM_SLOT - FIRST_SCRIPT_SLOT }, (_, i) => i + FIRST_SCRIPT_SLOT);
  assert.equal(nextFreeScriptId(allesVoll), null);
  assert.equal(nextFreeScriptId([...allesVoll, 150, 151]), null);
});

test("⚠ naechste freie Nummer: eine belegte Nummer wird nie gewaehlt", () => {
  for (let n = 0; n < 50; n++) {
    const used = BELEGT.filter(() => Math.random() > 0.3).concat([21, 22].filter(() => Math.random() > 0.5));
    const id = nextFreeScriptId(used);
    assert.ok(id === null || !used.includes(id), `gewaehlt ${id} ist belegt: ${used}`);
  }
});

// --- Anlegeweg gegen eine Attrappe der Maschine -------------------------------

function fakeMachine(opts: { placeAt?: (requested: number | null) => number | null } = {}) {
  const list = [...BELEGT];
  const store = new Map<number, { Title: string; Content: string }>();
  const creates: { scriptId: number | null; name: string }[] = [];
  const client = {
    scriptsList: async () => ({ index_list: [...list], title_list: list.map((i) => `S${i}`) }),
    scriptCreate: async (a: { scriptId: number | null; name: string; instruction: string }) => {
      creates.push({ scriptId: a.scriptId, name: a.name });
      const at = opts.placeAt ? opts.placeAt(a.scriptId) : a.scriptId;
      if (at !== null) { list.push(at); store.set(at, { Title: a.name, Content: a.instruction }); }
      return {};
    },
    scriptRead: async (id: number) => store.get(id) ?? { Title: `S${id}`, Content: "1;7;" },
  } as unknown as XeniaClient;
  const rows = new Map<number, XeniaScript>();
  const repo = {
    upsert: (s: XeniaScript) => { rows.set(s.id, s); },
    findById: (id: number) => rows.get(id),
    updateTitle: (id: number, title: string) => { const r = rows.get(id); if (r) r.title = title; },
  } as unknown as ScriptRepo;
  return { client, repo, creates, list };
}

const INHALT = "1;13;4 2000 2000;12 10000;6;12 12000;4 6000 2000;12 60000;7;";

test("anlegen: schreibt auf die kleinste freie Nummer und liefert sie zurueck", async () => {
  const m = fakeMachine();
  const s = await createScriptOnMachine(m.client, m.repo, "Test", INHALT);
  assert.equal(m.creates.length, 1);
  assert.equal(m.creates[0]!.scriptId, 21);
  assert.equal(s.id, 21);
  assert.equal(s.title, "Test");
});

test("⚠ anlegen: fordert nie eine belegte Nummer an", async () => {
  const m = fakeMachine();
  await createScriptOnMachine(m.client, m.repo, "Test", INHALT);
  assert.ok(!BELEGT.includes(m.creates[0]!.scriptId as number));
});

test("anlegen: landet das Skript woanders, wird das gemeldet statt uebernommen", async () => {
  const m = fakeMachine({ placeAt: () => 150 });
  await assert.rejects(
    createScriptOnMachine(m.client, m.repo, "Test", INHALT),
    /Platz 21.*150/,
  );
});

test("anlegen: taucht nichts auf, wird das gemeldet", async () => {
  const m = fakeMachine({ placeAt: () => null });
  await assert.rejects(createScriptOnMachine(m.client, m.repo, "Test", INHALT), /nicht in der Liste/);
});
