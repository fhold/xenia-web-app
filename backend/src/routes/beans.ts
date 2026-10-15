/**
 * Bean routes — CRUD + JSON import.
 *
 * Import schema: docs/bean-import-schema.md
 * Registered at: /api/beans
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SqliteBeanRepo } from "../db/bean-repo.js";
import type { SqliteCoffeeRepo } from "../db/coffee-repo.js";
import type { SettingsRepo } from "../db/settings-repo.js";
import type {
  BeanCreate,
  BeanStatus,
  BrewType,
  BeanRating,
  CoffeeCreate,
} from "../../../shared/src/types.js";
import { bestSureMatch } from "../lib/coffee-matching.js";

const VALID_RATINGS = new Set<BeanRating>(["thumbs_down", "meh", "thumbs_up"]);

// Valid roast levels from the schema
const VALID_ROAST_LEVELS = new Set([
  "light",
  "light-medium",
  "medium",
  "medium-dark",
  "dark",
]);

// Valid brew types from the schema (Step 8.5)
const VALID_BREW_TYPES = new Set(["espresso", "filter", "omni"]);

/**
 * Validates a `brewType` field on a create/update payload.
 * Returns an error message if present but invalid, otherwise null.
 * Absent or null is always accepted (the field is optional).
 */
function brewTypeError(body: Record<string, unknown>): string | null {
  if (!("brewType" in body)) return null;
  const v = body["brewType"];
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && VALID_BREW_TYPES.has(v)) return null;
  return "brewType must be one of: espresso, filter, omni (or null)";
}

// Fields accepted from the JSON import payload (maps from import key → BeanCreate key)
// Unknown keys are silently dropped.
const IMPORT_FIELD_MAP: Record<string, keyof BeanCreate | null> = {
  name:             "name",
  roaster:          "roaster",
  origin:           "country",      // import uses 'origin', DB uses 'country'
  region:           "region",
  farm:             null,           // not in import schema v1 — drop
  varietal:         "variety",      // import uses 'varietal', DB uses 'variety'
  process:          "processing",   // import uses 'process'
  altitude:         null,           // free-text string — handled separately below
  roastDate:        "roastDate",
  roastLevel:       "roastLevel",
  brewType:         "brewType",
  bagSizeG:         "bagSizeG",
  pricePerBagEur:   "pricePerBagEur",
  notes:            "notes",
  flavorNotes:      "flavorNotes",
};

export function registerBeanRoutes(
  app: FastifyInstance,
  beanRepo: SqliteBeanRepo,
  coffeeRepo: SqliteCoffeeRepo,
  settingsRepo: SettingsRepo,
): void {
  /**
   * §3.4b: resolve which coffee (Sorte) a legacy flat bean-create belongs to.
   * Honors an explicit coffeeId; otherwise uses the matching component to
   * auto-attach to a "sicher" existing coffee, falling back to creating a new
   * coffee from the master-data fields on the create payload. The bean's own
   * rating/favourite/master-data are NOT written back onto a matched coffee
   * (we don't clobber an existing Sorte from a re-purchase).
   */
  function resolveCoffeeId(create: BeanCreate): number {
    if (create.coffeeId !== undefined && create.coffeeId !== null) return create.coffeeId;
    const match = bestSureMatch(
      { name: create.name, roaster: create.roaster ?? null },
      coffeeRepo.listForMatching(),
    );
    if (match) return match.id;
    const coffee: CoffeeCreate = {
      name: create.name,
      roaster: create.roaster ?? null,
      country: create.country ?? null,
      region: create.region ?? null,
      farm: create.farm ?? null,
      variety: create.variety ?? null,
      processing: create.processing ?? null,
      altitudeMin: create.altitudeMin ?? null,
      altitudeMax: create.altitudeMax ?? null,
      roastLevel: create.roastLevel ?? null,
      brewType: create.brewType ?? null,
      flavorNotes: create.flavorNotes,
      notes: create.notes ?? null,
      favourite: create.favourite ?? false,
      rating: create.rating ?? null,
    };
    return coffeeRepo.insert(coffee);
  }
  /**
   * GET /api/beans
   * Query params: status (BeanStatus), favourite (boolean string)
   */
  app.get(
    "/api/beans",
    async (
      req: FastifyRequest<{ Querystring: { status?: string; favourite?: string } }>,
    ) => {
      const { status, favourite } = req.query;
      return beanRepo.listAll({
        status: status as BeanStatus | undefined,
        favourite: favourite !== undefined ? favourite === "true" : undefined,
      });
    },
  );

  /**
   * GET /api/beans/:id
   * NOTE: registered before /api/beans/import so Fastify's specificity rules work.
   * But /api/beans/import is a POST — no conflict with GET /:id.
   */
  app.get(
    "/api/beans/:id",
    async (
      req: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return reply.status(400).send({ error: "Invalid id" });
      const bean = beanRepo.findById(id);
      if (!bean) return reply.status(404).send({ error: "Bean not found" });
      return bean;
    },
  );

  /**
   * POST /api/beans
   * Body: BeanCreate
   */
  app.post(
    "/api/beans",
    async (
      req: FastifyRequest<{ Body: unknown }>,
      reply: FastifyReply,
    ) => {
      const body = req.body as Record<string, unknown> | null | undefined;
      const name = body?.name;
      if (typeof name !== "string" || name.trim() === "") {
        return reply.status(400).send({ error: "name is required" });
      }
      const btErr = brewTypeError(body ?? {});
      if (btErr) return reply.status(400).send({ error: btErr });
      const create = (body ?? {}) as unknown as BeanCreate;
      create.coffeeId = resolveCoffeeId(create);
      create.rating = null; // legacy create: rating lives on the coffee, no charge override
      const id = beanRepo.insert(create);
      return reply.status(201).send({ id, name });
    },
  );

  /**
   * PUT /api/beans/:id
   * Body: BeanUpdate (partial)
   */
  app.put(
    "/api/beans/:id",
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: unknown }>,
      reply: FastifyReply,
    ) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return reply.status(400).send({ error: "Invalid id" });
      if (!beanRepo.findById(id)) return reply.status(404).send({ error: "Bean not found" });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const btErr = brewTypeError(body);
      if (btErr) return reply.status(400).send({ error: btErr });
      beanRepo.update(id, body);
      return { ok: true };
    },
  );

  /**
   * POST /api/beans/:id/status
   * Body: { status: BeanStatus, date?: string (ISO 8601) }
   */
  app.post(
    "/api/beans/:id/status",
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Body: { status?: unknown; date?: unknown };
      }>,
      reply: FastifyReply,
    ) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return reply.status(400).send({ error: "Invalid id" });

      const { status, date } = req.body;
      const validStatuses: BeanStatus[] = ["stock", "frozen", "thawed", "archived"];
      if (!validStatuses.includes(status as BeanStatus)) {
        return reply.status(400).send({
          error: `status must be one of: ${validStatuses.join(", ")}`,
        });
      }
      if (date !== undefined && typeof date !== "string") {
        return reply.status(400).send({ error: "date must be an ISO 8601 string" });
      }

      if (!beanRepo.findById(id)) return reply.status(404).send({ error: "Bean not found" });
      beanRepo.setStatus(id, status as BeanStatus, date as string | undefined);
      return { ok: true };
    },
  );

  /**
   * POST /api/beans/:id/active — §3g: toggle the active-source flag.
   * Body: { isActive: boolean }. Independent of the physical status; any number
   * of roastings can be active at once.
   */
  app.post(
    "/api/beans/:id/active",
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { isActive?: unknown } }>,
      reply: FastifyReply,
    ) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return reply.status(400).send({ error: "Invalid id" });
      const isActive = req.body?.isActive;
      if (typeof isActive !== "boolean") {
        return reply.status(400).send({ error: "isActive (boolean) is required" });
      }
      if (!beanRepo.findById(id)) return reply.status(404).send({ error: "Bean not found" });
      beanRepo.setActive(id, isActive);
      return { ok: true };
    },
  );

  /**
   * POST /api/beans/:id/archive — Beutel ist aufgebraucht.
   * Body: { openNextId?: number } — die Reserve-Roestung, die stattdessen als
   * Bezugsquelle aktiv wird. Beides in einem Aufruf, weil "archivieren" und
   * "naechsten oeffnen" fuer den Nutzer eine Handlung sind; getrennte Requests
   * koennten auf halbem Weg stehenbleiben und die Bohnenauswahl leer lassen.
   */
  app.post(
    "/api/beans/:id/archive",
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { openNextId?: unknown } }>,
      reply: FastifyReply,
    ) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return reply.status(400).send({ error: "Invalid id" });
      if (!beanRepo.findById(id)) return reply.status(404).send({ error: "Bean not found" });

      const openNextId = req.body?.openNextId;
      if (openNextId !== undefined && openNextId !== null) {
        if (typeof openNextId !== "number" || !Number.isInteger(openNextId)) {
          return reply.status(400).send({ error: "openNextId must be an integer" });
        }
        if (!beanRepo.findById(openNextId)) {
          return reply.status(404).send({ error: "Next roasting not found" });
        }
      }

      beanRepo.setStatus(id, "archived");
      if (typeof openNextId === "number") {
        beanRepo.setActive(openNextId, true);
        // Damit der Pre-Shot-Dialog sofort die neue Packung vorschlaegt: der
        // bisherige Vorschlag zeigt auf die eben archivierte Roestung und faellt
        // durch den Pickable-Filter, das Feld bliebe sonst leer.
        settingsRepo.set("active_bean_id", String(openNextId));
      }
      return { ok: true };
    },
  );

  /**
   * POST /api/beans/:id/stock-alert/dismiss — "nicht jetzt" auf den
   * Aufgebraucht-Hinweis. Gilt nur fuer diese Roestung und wird beim Korrigieren
   * von Restmenge/Beutelgroesse wieder aufgehoben.
   */
  app.post(
    "/api/beans/:id/stock-alert/dismiss",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return reply.status(400).send({ error: "Invalid id" });
      if (!beanRepo.findById(id)) return reply.status(404).send({ error: "Bean not found" });
      beanRepo.dismissStockAlert(id);
      return { ok: true };
    },
  );

  /**
   * POST /api/beans/import
   *
   * Accepts the JSON format from docs/bean-import-schema.md.
   * - name is required
   * - Unknown fields are dropped (logged at info level)
   * - roastLevel with unknown value → null + warning logged
   * - bagSizeG set → remaining_g initialized to bagSizeG
   * - Returns { id, name } on success
   */
  app.post(
    "/api/beans/import",
    async (
      req: FastifyRequest<{ Body: unknown }>,
      reply: FastifyReply,
    ) => {
      const raw = req.body as Record<string, unknown> | null | undefined;

      if (!raw || typeof raw !== "object") {
        return reply.status(400).send({ error: "Body must be a JSON object" });
      }

      // Validate required field
      const name = raw["name"];
      if (typeof name !== "string" || name.trim() === "") {
        return reply.status(400).send({ error: "name ist erforderlich" });
      }

      const bean: BeanCreate = { name: name.trim() };
      const unknown: string[] = [];

      for (const [rawKey, value] of Object.entries(raw)) {
        if (rawKey === "name") continue;

        if (!(rawKey in IMPORT_FIELD_MAP)) {
          unknown.push(rawKey);
          continue;
        }

        const mappedKey = IMPORT_FIELD_MAP[rawKey];
        if (mappedKey === null) continue; // explicitly dropped field

        // Special handling per field type
        if (mappedKey === "roastLevel") {
          if (typeof value === "string" && VALID_ROAST_LEVELS.has(value)) {
            bean.roastLevel = value as BeanCreate["roastLevel"];
          } else {
            app.log.warn(`bean import: unknown roastLevel value "${String(value)}" — set to null`);
            bean.roastLevel = null;
          }
        } else if (mappedKey === "brewType") {
          if (typeof value === "string" && VALID_BREW_TYPES.has(value)) {
            bean.brewType = value as BrewType;
          } else {
            app.log.warn(`bean import: unknown brewType value "${String(value)}" — set to null`);
            bean.brewType = null;
          }
        } else if (mappedKey === "flavorNotes") {
          if (Array.isArray(value)) {
            bean.flavorNotes = value.filter((v): v is string => typeof v === "string");
          }
        } else if (mappedKey === "bagSizeG" || mappedKey === "pricePerBagEur") {
          if (typeof value === "number" && isFinite(value)) {
            bean[mappedKey] = value;
          }
        } else if (typeof value === "string") {
          // String fields: roaster, country, region, variety, processing, notes, roastDate
          (bean[mappedKey] as string) = value;
        }
      }

      if (unknown.length > 0) {
        app.log.info(`bean import: unknown fields dropped: ${unknown.join(", ")}`);
      }

      // If bagSizeG is set, initialize remainingG to the same value
      if (bean.bagSizeG !== undefined && bean.bagSizeG !== null) {
        bean.remainingG = bean.bagSizeG;
      }

      bean.status = "stock"; // §3g: imported roastings start in stock, inactive
      bean.favourite = false;

      // §3.4b: attach to a matching coffee (sicher) or create a new one.
      bean.coffeeId = resolveCoffeeId(bean);
      bean.rating = null; // no charge override on import
      const id = beanRepo.insert(bean);
      app.log.info(`bean import: created roasting #${id} "${bean.name}" → coffee #${bean.coffeeId}`);
      return reply.status(201).send({ id, name: bean.name });
    },
  );

  /**
   * POST /api/beans/:id/move — reassign this roasting to another coffee.
   * Body: { coffeeId: number }. (Merge/Move primitive — §3.4b.)
   */
  app.post(
    "/api/beans/:id/move",
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { coffeeId?: unknown } }>,
      reply: FastifyReply,
    ) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return reply.status(400).send({ error: "Invalid id" });
      const coffeeId = req.body?.coffeeId;
      if (typeof coffeeId !== "number" || !Number.isInteger(coffeeId)) {
        return reply.status(400).send({ error: "coffeeId (integer) is required" });
      }
      if (!beanRepo.findById(id)) return reply.status(404).send({ error: "Bean not found" });
      if (!coffeeRepo.findById(coffeeId)) return reply.status(404).send({ error: "Target coffee not found" });
      beanRepo.move(id, coffeeId);
      return { ok: true };
    },
  );

  /**
   * POST /api/beans/:id/rating-override — set/clear the charge-level rating
   * override ("abweichend bewerten"). Body: { rating: BeanRating | null }.
   * null clears the override (the roasting inherits coffee.rating again).
   */
  app.post(
    "/api/beans/:id/rating-override",
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { rating?: unknown } }>,
      reply: FastifyReply,
    ) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return reply.status(400).send({ error: "Invalid id" });
      const rating = req.body?.rating;
      if (rating !== null && !(typeof rating === "string" && VALID_RATINGS.has(rating as BeanRating))) {
        return reply.status(400).send({ error: "rating must be a BeanRating or null" });
      }
      if (!beanRepo.findById(id)) return reply.status(404).send({ error: "Bean not found" });
      beanRepo.setRatingOverride(id, (rating as BeanRating | null) ?? null);
      return { ok: true };
    },
  );

  /**
   * DELETE /api/beans/:id
   */
  app.delete(
    "/api/beans/:id",
    async (
      req: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return reply.status(400).send({ error: "Invalid id" });
      if (!beanRepo.findById(id)) return reply.status(404).send({ error: "Bean not found" });
      beanRepo.delete(id);
      return { ok: true };
    },
  );
}
