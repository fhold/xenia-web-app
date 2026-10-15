/**
 * Rückfrage beim Aktivieren einer Röstung: welche anderen sind noch aktiv, und
 * welche Antwort liegt nahe. Runner: node:test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { activeSiblings, preferDeactivate } from "../src/coffee.js";
import type { Bean } from "../src/types.js";

const bean = (id: number, isActive: boolean, status: Bean["status"] = "stock") =>
  ({ id, isActive, status }) as Bean;

test("die neue selbst zählt nicht, inaktive auch nicht", () => {
  assert.deepEqual(activeSiblings([bean(1, true), bean(2, false)], 1), []);
});

test("eine aktive ältere Röstung wird gefunden", () => {
  assert.deepEqual(activeSiblings([bean(1, false), bean(2, true)], 1).map((b) => b.id), [2]);
});

test("⚠ archivierte zählen nie, auch mit stehengebliebenem Aktiv-Flag", () => {
  assert.deepEqual(activeSiblings([bean(1, false), bean(2, true, "archived")], 1), []);
});

test("mehrere aktive werden alle genannt", () => {
  const r = activeSiblings([bean(1, false), bean(2, true), bean(3, true, "thawed")], 1);
  assert.deepEqual(r.map((b) => b.id), [2, 3]);
});

test("eingefroren → nur inaktiv setzen liegt nahe, sonst archivieren", () => {
  assert.equal(preferDeactivate([bean(2, true, "frozen")]), true);
  assert.equal(preferDeactivate([bean(2, true, "stock")]), false);
  assert.equal(preferDeactivate([bean(2, true, "frozen"), bean(3, true, "thawed")]), false);
  assert.equal(preferDeactivate([]), false);
});
