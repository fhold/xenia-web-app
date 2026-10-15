/**
 * Ueberschreiben nur ohne Konflikt.
 *
 * Flavio bearbeitet Skripte auch in der Xenia-Oberflaeche. Speichert der
 * App-Editor danach einen Stand, der auf dem alten Inhalt beruht, ginge die
 * Aenderung an der Maschine still verloren. Deshalb vergleicht das
 * Ueberschreiben zuerst den Maschinenstand mit dem Stand beim Oeffnen.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { overwriteScriptOnMachine, ScriptConflictError } from "../src/xenia/script-sync.js";
import type { XeniaClient } from "../src/xenia/client.js";
import type { ScriptRepo } from "../src/db/script-repo.js";
import type { XeniaScript } from "../../shared/src/types.js";

const OPENED = "1;13;4 6000 2000;12 60000;7;";
const EDITED = "1;13;4 6500 3000;12 60000;7;";

function fakeMachine(content: string) {
  const store = new Map<number, { Title: string; Content: string }>([[13, { Title: "medium brew solo", Content: content }]]);
  const writes: { scriptId: number | null; instruction: string }[] = [];
  const client = {
    scriptRead: async (id: number) => store.get(id)!,
    scriptCreate: async (a: { scriptId: number; name: string; instruction: string }) => {
      writes.push({ scriptId: a.scriptId, instruction: a.instruction });
      store.set(a.scriptId, { Title: a.name, Content: a.instruction });
      return {};
    },
  } as unknown as XeniaClient;
  const rows = new Map<number, XeniaScript>();
  const repo = {
    upsert: (s: XeniaScript) => { rows.set(s.id, s); },
    findById: (id: number) => rows.get(id),
    updateTitle: (id: number, title: string) => { const r = rows.get(id); if (r) r.title = title; },
  } as unknown as ScriptRepo;
  return { client, repo, writes, store };
}

test("unveraendert an der Maschine: wird ueberschrieben", async () => {
  const m = fakeMachine(OPENED);
  const s = await overwriteScriptOnMachine(m.client, m.repo, 13, "medium brew solo", EDITED, OPENED);
  assert.equal(m.writes.length, 1);
  assert.equal(m.writes[0]!.scriptId, 13);
  assert.equal(s.content, EDITED);
});

test("⚠ an der Maschine geaendert: nichts wird geschrieben, der Maschinenstand kommt zurueck", async () => {
  const onMachine = "1;13;4 7000 2000;12 60000;7;";
  const m = fakeMachine(onMachine);
  await assert.rejects(
    overwriteScriptOnMachine(m.client, m.repo, 13, "medium brew solo", EDITED, OPENED),
    (err: unknown) => err instanceof ScriptConflictError && err.machineContent === onMachine,
  );
  assert.equal(m.writes.length, 0);
  assert.equal(m.store.get(13)!.Content, onMachine);
});

test("nur Leerraum anders ist kein Konflikt", async () => {
  const m = fakeMachine("1; 13 ;4 6000 2000;12 60000;7");
  await overwriteScriptOnMachine(m.client, m.repo, 13, "medium brew solo", EDITED, OPENED);
  assert.equal(m.writes.length, 1);
});

test("umbenennen wird uebernommen", async () => {
  const m = fakeMachine(OPENED);
  const s = await overwriteScriptOnMachine(m.client, m.repo, 13, "medium brew v2", EDITED, OPENED);
  assert.equal(s.title, "medium brew v2");
});
