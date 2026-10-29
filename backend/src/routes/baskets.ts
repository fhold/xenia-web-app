/**
 * Sieb-Routen — CRUD wie die Muehlen.
 * Registered at: /api/baskets
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SqliteBasketRepo } from "../db/basket-repo.js";
import { BASKET_TYPES } from "../../../shared/src/types.js";
import type { BasketType, BasketUpdate } from "../../../shared/src/types.js";
import { L } from "../../../shared/src/shared-lang.js";

/** Name wie ein Profilname: Pflicht, getrimmt, hoechstens 40 Zeichen. */
function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const n = v.trim();
  return n.length > 0 && n.length <= 40 ? n : null;
}

const isType = (v: unknown): v is BasketType => typeof v === "string" && (BASKET_TYPES as string[]).includes(v);

/** Beschreibung: frei, hoechstens 200 Zeichen; leer → null. undefined = ungueltig. */
function cleanDescription(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const d = v.trim();
  if (d.length > 200) return undefined;
  return d.length > 0 ? d : null;
}

/** Nenndosis in g: 0 < x ≤ 40 oder null. undefined = ungueltig. */
function cleanDose(v: unknown): number | null | undefined {
  if (v === null) return null;
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 40 ? Math.round(v * 10) / 10 : undefined;
}

const BAD_DESCRIPTION = () => L("Beschreibung: höchstens 200 Zeichen.", "Description: at most 200 characters.");
const BAD_DOSE = () => L("Nenndosis: eine Zahl über 0 bis 40 g.", "Nominal dose: a number above 0 up to 40 g.");

export function registerBasketRoutes(app: FastifyInstance, basketRepo: SqliteBasketRepo): void {
  /** GET /api/baskets — nach Typ, dann Name */
  app.get("/api/baskets", async () => basketRepo.listAll());

  /** POST /api/baskets — Body: { name, description?, nominalDoseG?, type? } */
  app.post("/api/baskets", async (req: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = cleanName(body.name);
    if (name === null) return reply.status(400).send({ error: L("Name fehlt (höchstens 40 Zeichen)", "name is required (max. 40 characters)") });
    if (body.type !== undefined && !isType(body.type)) return reply.status(400).send({ error: L("Typ muss single, double oder he sein", "type must be single, double or he") });
    const description = body.description === undefined ? null : cleanDescription(body.description);
    if (description === undefined) return reply.status(400).send({ error: BAD_DESCRIPTION() });
    const nominalDoseG = body.nominalDoseG === undefined ? null : cleanDose(body.nominalDoseG);
    if (nominalDoseG === undefined) return reply.status(400).send({ error: BAD_DOSE() });
    const id = basketRepo.insert({ name, type: isType(body.type) ? body.type : undefined, description, nominalDoseG });
    return reply.status(201).send({ id, name });
  });

  /** PUT /api/baskets/:id — Body: { name?, description?, nominalDoseG?, type? } */
  app.put("/api/baskets/:id", async (req: FastifyRequest<{ Params: { id: string }; Body: unknown }>, reply: FastifyReply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: L("Ungültige ID", "Invalid id") });
    if (!basketRepo.findById(id)) return reply.status(404).send({ error: L("Sieb nicht gefunden", "Basket not found") });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: BasketUpdate = {};
    if (body.name !== undefined) {
      const name = cleanName(body.name);
      if (name === null) return reply.status(400).send({ error: L("Name fehlt (höchstens 40 Zeichen)", "name is required (max. 40 characters)") });
      patch.name = name;
    }
    if (body.type !== undefined) {
      if (!isType(body.type)) return reply.status(400).send({ error: L("Typ muss single, double oder he sein", "type must be single, double or he") });
      patch.type = body.type;
    }
    if (body.description !== undefined) {
      const d = cleanDescription(body.description);
      if (d === undefined) return reply.status(400).send({ error: BAD_DESCRIPTION() });
      patch.description = d;
    }
    if (body.nominalDoseG !== undefined) {
      const g = cleanDose(body.nominalDoseG);
      if (g === undefined) return reply.status(400).send({ error: BAD_DOSE() });
      patch.nominalDoseG = g;
    }
    basketRepo.update(id, patch);
    return { ok: true };
  });

  /** DELETE /api/baskets/:id */
  app.delete("/api/baskets/:id", async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: L("Ungültige ID", "Invalid id") });
    if (!basketRepo.findById(id)) return reply.status(404).send({ error: L("Sieb nicht gefunden", "Basket not found") });
    // Benutzte Siebe bleiben — sonst verloeren Bezuege und Varianten ihr Sieb.
    const u = basketRepo.usage(id);
    if (u.variants > 0 || u.shots > 0) {
      return reply.status(409).send({ error: L(`Sieb wird benutzt (${u.shots} Bezüge, ${u.variants} Varianten) und lässt sich nicht löschen.`, `The basket is in use (${u.shots} shots, ${u.variants} variants) and cannot be deleted.`) });
    }
    basketRepo.delete(id);
    return { ok: true };
  });
}
