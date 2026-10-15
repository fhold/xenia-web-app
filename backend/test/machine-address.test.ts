/**
 * Maschinen-Adresse in den Einstellungen: speichern, sofort umschalten, aber
 * nie waehrend eines Bezugs. Dazu der Vorrang der gespeicherten Einstellung vor
 * MACHINE_IP (die Service-Unit setzt die Variable bei jedem Start).
 *
 * Runner: node:test via tsx, fastify.inject() — kein Socket, keine Maschine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerMachineAddressRoute } from "../src/routes/machine-address.js";

function makeApp(opts: { brewing?: boolean } = {}) {
  const stored = new Map<string, string>();
  const changes: string[] = [];
  let host = "192.168.1.100";
  const client = {
    get host() { return host; },
    setHost(h: string) { host = h; },
  };
  const app = Fastify({ logger: false });
  registerMachineAddressRoute(app, {
    client,
    settings: { set: (k, v) => { stored.set(k, v); } },
    isBrewing: () => opts.brewing ?? false,
    log: (from, to) => changes.push(`${from}→${to}`),
  });
  return { app, stored, changes, client };
}

test("gueltige Adresse: gespeichert, Client sofort umgeschaltet", async () => {
  const h = makeApp();
  const res = await h.app.inject({ method: "PUT", url: "/api/machine/address", payload: { address: " Xenia.local:8080 " } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, address: "xenia.local:8080" });
  assert.equal(h.stored.get("machine_ip"), "xenia.local:8080");
  assert.equal(h.client.host, "xenia.local:8080");
  assert.deepEqual(h.changes, ["192.168.1.100→xenia.local:8080"]);
});

test("ungueltige Adresse: 400, nichts gespeichert, Client unveraendert", async () => {
  const h = makeApp();
  for (const payload of [{ address: "192.168.1.300" }, { address: "http://x" }, { address: 42 }, {}]) {
    const res = await h.app.inject({ method: "PUT", url: "/api/machine/address", payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
  assert.equal(h.stored.size, 0);
  assert.equal(h.client.host, "192.168.1.100");
});

test("waehrend eines Bezugs: 409, Client bleibt auf der alten Adresse", async () => {
  const h = makeApp({ brewing: true });
  const res = await h.app.inject({ method: "PUT", url: "/api/machine/address", payload: { address: "10.0.0.7" } });
  assert.equal(res.statusCode, 409);
  assert.equal(h.stored.size, 0);
  assert.equal(h.client.host, "192.168.1.100");
});

test("gleiche Adresse: gespeichert, aber kein Umschalten und kein Log", async () => {
  const h = makeApp();
  const res = await h.app.inject({ method: "PUT", url: "/api/machine/address", payload: { address: "192.168.1.100" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(h.changes, []);
});
