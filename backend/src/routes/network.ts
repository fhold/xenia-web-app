/**
 * Netz Profil ↔ Bohne (Schnitt 4).
 *
 * GET /api/network/coffee/:id  — „Mit diesen Profilen“: je Sieb und Muehle die
 *                                Profile — nur Siebe mit Bezuegen
 * GET /api/network/profile/:id — „Lief mit“: je Variante und Muehle die Sorten
 *
 * Die Rechnung ist rein (shared/src/network.ts); hier nur Lesen.
 */

import type { FastifyInstance } from "fastify";
import type { ShotRepo } from "../db/shot-repo.js";
import type { ApiResponse } from "../../../shared/src/types.js";
import { groupNetwork, type CoffeeNetwork, type ProfileNetwork } from "../../../shared/src/network.js";
import { L } from "../../../shared/src/shared-lang.js";

export function registerNetworkRoutes(app: FastifyInstance, shotRepo: ShotRepo): void {
  const idOf = (raw: unknown) => parseInt((raw as { id: string }).id, 10);

  app.get("/api/network/coffee/:id", async (req, reply) => {
    const coffeeId = idOf(req.params);
    if (Number.isNaN(coffeeId)) {
      reply.status(400);
      return { ok: false, error: L("Ungültige Sorten-ID", "Invalid coffee ID") } as ApiResponse;
    }
    const shots = shotRepo.listNetworkShots({ coffeeId });
    const groups = groupNetwork(
      shots,
      (s) => ({ basketId: s.basketId, variantId: null, grinderId: s.grinderId }),
      (s) => ({ key: s.profileId !== null ? `p${s.profileId}` : `-${s.profileName}`, id: s.profileId, label: s.profileName }),
    );
    const res: CoffeeNetwork = { groups };
    return res;
  });

  app.get("/api/network/profile/:id", async (req, reply) => {
    const profileId = idOf(req.params);
    if (Number.isNaN(profileId)) {
      reply.status(400);
      return { ok: false, error: L("Ungültige Profil-ID", "Invalid profile ID") } as ApiResponse;
    }
    const groups = groupNetwork(
      shotRepo.listNetworkShots({ profileId }),
      (s) => ({ basketId: null, variantId: s.variantId, grinderId: s.grinderId }),
      (s) => (s.coffeeId !== null
        ? { key: `c${s.coffeeId}`, id: s.coffeeId, label: s.coffeeName ?? `#${s.coffeeId}` }
        : s.beanLabel ? { key: `l:${s.beanLabel.toLowerCase()}`, id: null, label: s.beanLabel } : { key: "-", id: null, label: "ohne Bohne" }),
    );
    const res: ProfileNetwork = { groups };
    return res;
  });
}
