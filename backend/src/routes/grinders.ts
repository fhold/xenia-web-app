/**
 * Grinder routes — CRUD.
 * Registered at: /api/grinders
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SqliteGrinderRepo } from "../db/grinder-repo.js";
import type { GrinderCreate, GrinderUpdate } from "../../../shared/src/types.js";

export function registerGrinderRoutes(
  app: FastifyInstance,
  grinderRepo: SqliteGrinderRepo,
): void {
  /**
   * GET /api/grinders — list all grinders sorted by name
   */
  app.get("/api/grinders", async () => {
    return grinderRepo.listAll();
  });

  /**
   * GET /api/grinders/:id
   */
  app.get(
    "/api/grinders/:id",
    async (
      req: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return reply.status(400).send({ error: "Invalid id" });
      const grinder = grinderRepo.findById(id);
      if (!grinder) return reply.status(404).send({ error: "Grinder not found" });
      return grinder;
    },
  );

  /**
   * POST /api/grinders
   * Body: GrinderCreate — name is required
   */
  app.post(
    "/api/grinders",
    async (
      req: FastifyRequest<{ Body: unknown }>,
      reply: FastifyReply,
    ) => {
      const body = req.body as Record<string, unknown> | null | undefined;
      const name = body?.name;
      if (typeof name !== "string" || name.trim() === "") {
        return reply.status(400).send({ error: "name is required" });
      }
      const id = grinderRepo.insert(body as unknown as GrinderCreate);
      return reply.status(201).send({ id, name });
    },
  );

  /**
   * PUT /api/grinders/:id
   * Body: GrinderUpdate (partial)
   */
  app.put(
    "/api/grinders/:id",
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: unknown }>,
      reply: FastifyReply,
    ) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return reply.status(400).send({ error: "Invalid id" });
      if (!grinderRepo.findById(id)) {
        return reply.status(404).send({ error: "Grinder not found" });
      }
      grinderRepo.update(id, req.body as GrinderUpdate);
      return { ok: true };
    },
  );

  /**
   * DELETE /api/grinders/:id
   */
  app.delete(
    "/api/grinders/:id",
    async (
      req: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return reply.status(400).send({ error: "Invalid id" });
      if (!grinderRepo.findById(id)) {
        return reply.status(404).send({ error: "Grinder not found" });
      }
      grinderRepo.delete(id);
      return { ok: true };
    },
  );
}
