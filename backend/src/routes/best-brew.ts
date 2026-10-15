/**
 * Best Brew routes (BB-a).
 *
 * POST   /api/best-brew        — set/move the reference from { shotId }
 * DELETE /api/best-brew        — unflag by ?shotId= or ?coffeeId=
 *
 * One reference per Sorte (coffee); POST upserts (moves the star). The Sorte is
 * derived server-side from the shot (shot → bean → coffee), so the client only
 * ever sends a shotId.
 */

import type { FastifyInstance } from "fastify";
import type { BestBrewRepo } from "../db/best-brew-repo.js";
import type { ApiResponse } from "../../../shared/src/types.js";

export function registerBestBrewRoutes(
  app: FastifyInstance,
  bestBrewRepo: BestBrewRepo,
): void {
  // POST /api/best-brew — set/move reference. Body: { shotId }.
  app.post("/api/best-brew", async (req, reply) => {
    const body = (req.body ?? {}) as { shotId?: unknown };
    const shotId = typeof body.shotId === "number" ? body.shotId : NaN;
    if (!Number.isInteger(shotId)) {
      return reply.status(400).send({ ok: false, error: "shotId is required" } as ApiResponse);
    }
    const result = bestBrewRepo.setByShot(shotId);
    if (!result.ok) {
      return reply.status(400).send({ ok: false, error: result.error } as ApiResponse);
    }
    return { ok: true, coffeeId: result.coffeeId };
  });

  // DELETE /api/best-brew?shotId=  or  ?coffeeId=
  app.delete("/api/best-brew", async (req, reply) => {
    const q = req.query as { shotId?: string; coffeeId?: string };
    const shotId = q.shotId ? parseInt(q.shotId, 10) : NaN;
    const coffeeId = q.coffeeId ? parseInt(q.coffeeId, 10) : NaN;

    let removed = false;
    if (Number.isInteger(shotId)) {
      removed = bestBrewRepo.unsetByShot(shotId);
    } else if (Number.isInteger(coffeeId)) {
      removed = bestBrewRepo.unsetByCoffee(coffeeId);
    } else {
      return reply.status(400).send({ ok: false, error: "shotId or coffeeId is required" } as ApiResponse);
    }
    if (!removed) {
      return reply.status(404).send({ ok: false, error: "No best-brew reference to remove" } as ApiResponse);
    }
    const res: ApiResponse = { ok: true };
    return res;
  });
}
