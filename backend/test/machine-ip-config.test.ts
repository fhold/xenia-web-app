/**
 * Woher die App die Maschinen-Adresse nimmt: MACHINE_IP setzt nur den
 * Anfangswert einer frischen Datenbank, danach gilt die gespeicherte
 * Einstellung — sonst wuerde die Service-Unit (setzt MACHINE_IP bei jedem
 * Start) eine in den Einstellungen geaenderte Adresse wieder ueberschreiben.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.DB_PATH = path.join(os.tmpdir(), `machine-ip-${process.pid}-${Date.now()}.db`);
process.env.MACHINE_IP = "10.0.0.7";

const { initDb, closeDb } = await import("../src/db/index.js");
const { applySchema } = await import("../src/db/schema.js");
const { seedSettings } = await import("../src/db/seed.js");
const { loadConfig } = await import("../src/config.js");
const { SqliteSettingsRepo } = await import("../src/db/settings-repo.js");

after(() => {
  closeDb();
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${process.env.DB_PATH!}${s}`, { force: true });
  delete process.env.MACHINE_IP;
});

test("MACHINE_IP seedet die frische DB, danach gewinnt die Einstellung", () => {
  initDb();
  applySchema();
  seedSettings();
  assert.equal(loadConfig().machineIp, "10.0.0.7");

  new SqliteSettingsRepo().set("machine_ip", "192.168.1.50");
  seedSettings(); // naechster Start: ueberschreibt nichts
  assert.equal(loadConfig().machineIp, "192.168.1.50");
});
