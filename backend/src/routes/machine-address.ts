/**
 * PUT /api/machine/address — Adresse der Xenia aendern, wirkt sofort.
 *
 * Speichert `machine_ip` und schaltet den gemeinsamen Client um; die naechste
 * Abfrage des Pollers geht schon an die neue Adresse. Waehrend eines Bezugs
 * (Aufzeichnung offen oder Flow-Hold aktiv) abgelehnt: mitten im Bezug die
 * Maschine zu wechseln, liesse Stopp und Watchdog ins Leere laufen.
 */

import type { FastifyInstance } from "fastify";
import { normalizeMachineAddress } from "../../../shared/src/machine-address.js";
import { L } from "../../../shared/src/shared-lang.js";

export interface MachineAddressDeps {
  client: { readonly host: string; setHost(host: string): void };
  settings: { set(key: string, value: string): void };
  isBrewing: () => boolean;
  log: (from: string, to: string) => void;
}

export function registerMachineAddressRoute(app: FastifyInstance, deps: MachineAddressDeps): void {
  app.put("/api/machine/address", async (req, reply) => {
    const body = req.body as { address?: unknown } | undefined;
    const address = typeof body?.address === "string" ? normalizeMachineAddress(body.address) : null;
    if (address === null) {
      reply.status(400);
      return { ok: false, error: L("Ungültige Adresse — erwartet IP oder Hostname, optional mit :Port", "Invalid address — expected an IP or host name, optionally with :port") };
    }
    if (deps.isBrewing()) {
      reply.status(409);
      return { ok: false, error: L("Während eines Bezugs lässt sich die Adresse nicht ändern", "The address cannot be changed during a brew") };
    }
    const from = deps.client.host;
    deps.settings.set("machine_ip", address);
    if (address !== from) {
      deps.client.setHost(address);
      deps.log(from, address);
    }
    return { ok: true, address };
  });
}
