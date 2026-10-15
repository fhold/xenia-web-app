/**
 * Coffee (Sorte) routes — §3.4b.
 *
 *   GET    /api/coffees                  — list coffees (fav first, with counts)
 *   GET    /api/coffees/match            — matching suggestions (?name=&roaster=)
 *   GET    /api/coffees/:id              — one coffee
 *   GET    /api/coffees/:id/roastings    — roastings (beans) of a coffee
 *   POST   /api/coffees                  — create coffee
 *   POST   /api/coffees/:id/roastings    — "Nachkaufen": new roasting under coffee
 *   POST   /api/coffees/:id/merge        — merge: move all roastings to target, delete source
 *   PUT    /api/coffees/:id              — update master data / favourite / rating
 *   DELETE /api/coffees/:id              — delete (only when empty; ON DELETE RESTRICT)
 */

import { MAX_IMAGE_BYTES, sniffImageMime } from "../../../shared/src/image-mime.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SqliteCoffeeRepo } from "../db/coffee-repo.js";
import type { SqliteBeanRepo } from "../db/bean-repo.js";
import type { BestBrewRepo } from "../db/best-brew-repo.js";
import { getDb } from "../db/index.js";
import { matchAgainstCoffees } from "../lib/coffee-matching.js";
import type {
  BeanCreate,
  BeanStatus,
  BrewType,
  BeanRating,
} from "../../../shared/src/types.js";

const VALID_BREW_TYPES = new Set<BrewType>(["espresso", "filter", "omni"]);
const VALID_RATINGS = new Set<BeanRating>(["thumbs_down", "meh", "thumbs_up"]);
const VALID_BEAN_STATUS = new Set<BeanStatus>(["stock", "frozen", "thawed", "archived"]);

/**
 * Build the BeanCreate for an atomic first roasting (§3.4b / §3i). Returns
 * `{ error }` on a hard validation failure (bagSizeG missing/≤0), else
 * `{ create }`. `firstRoasting` is the already-confirmed plain object.
 * Defaults: status `stock`, isActive `true`, remaining = full bag. Invalid
 * `status`/`isActive` values fall back to the defaults (soft) — the parser
 * surfaces those to the user; the backend just stays robust.
 * `frozenDate`/`thawDate` are derived from `status` (mirrors setStatus).
 */
function buildFirstRoasting(
  coffeeId: number,
  coffeeName: string,
  fr: Record<string, unknown>,
): { create: BeanCreate } | { error: string } {
  const bagSizeG = typeof fr["bagSizeG"] === "number" ? (fr["bagSizeG"] as number) : NaN;
  if (!Number.isFinite(bagSizeG) || bagSizeG <= 0) {
    return { error: "firstRoasting.bagSizeG (positive number) is required" };
  }
  const status: BeanStatus =
    typeof fr["status"] === "string" && VALID_BEAN_STATUS.has(fr["status"] as BeanStatus)
      ? (fr["status"] as BeanStatus)
      : "stock";
  const isActive = typeof fr["isActive"] === "boolean" ? (fr["isActive"] as boolean) : true;
  const today = new Date().toISOString().slice(0, 10);
  const create: BeanCreate = {
    name: coffeeName,
    coffeeId,
    roastDate: typeof fr["roastDate"] === "string" ? (fr["roastDate"] as string) : null,
    bagSizeG,
    remainingG: bagSizeG, // §3.4b: always full bag, like "Nachkaufen"
    pricePerBagEur: typeof fr["pricePerBagEur"] === "number" ? (fr["pricePerBagEur"] as number) : null,
    status,
    isActive,
    // Mirror setStatus: a frozen/thawed roasting carries the corresponding date
    // so effective-age math credits the freeze. stock/archived carry neither.
    frozenDate: status === "frozen" ? today : null,
    thawDate: status === "thawed" ? today : null,
    rating: null,
  };
  return { create };
}

function brewTypeError(body: Record<string, unknown>): string | null {
  if (!("brewType" in body)) return null;
  const v = body["brewType"];
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && VALID_BREW_TYPES.has(v as BrewType)) return null;
  return "brewType must be one of: espresso, filter, omni (or null)";
}

function ratingError(body: Record<string, unknown>): string | null {
  if (!("rating" in body)) return null;
  const v = body["rating"];
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && VALID_RATINGS.has(v as BeanRating)) return null;
  return "rating must be one of: thumbs_down, meh, thumbs_up (or null)";
}

export function registerCoffeeRoutes(
  app: FastifyInstance,
  coffeeRepo: SqliteCoffeeRepo,
  beanRepo: SqliteBeanRepo,
  bestBrewRepo: BestBrewRepo,
): void {
  // GET /api/coffees — BB-a: each coffee carries its live-joined best-brew ref.
  app.get("/api/coffees", async () =>
    coffeeRepo.listAll().map((c) => ({ ...c, bestBrew: bestBrewRepo.getSummary(c.id) })),
  );

  // GET /api/coffees/match?name=&roaster= — registered before /:id (static wins).
  app.get(
    "/api/coffees/match",
    async (req: FastifyRequest<{ Querystring: { name?: string; roaster?: string } }>, reply) => {
      const name = (req.query.name ?? "").trim();
      if (name === "") return reply.status(400).send({ error: "name is required" });
      const roaster = req.query.roaster ?? null;
      return matchAgainstCoffees({ name, roaster }, coffeeRepo.listForMatching());
    },
  );

  // GET /api/coffees/:id
  app.get(
    "/api/coffees/:id",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return reply.status(400).send({ error: "Invalid id" });
      const coffee = coffeeRepo.findById(id);
      if (!coffee) return reply.status(404).send({ error: "Coffee not found" });
      return { ...coffee, bestBrew: bestBrewRepo.getSummary(id) };
    },
  );

  // GET /api/coffees/:id/roastings
  app.get(
    "/api/coffees/:id/roastings",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return reply.status(400).send({ error: "Invalid id" });
      if (!coffeeRepo.findById(id)) return reply.status(404).send({ error: "Coffee not found" });
      return beanRepo.listByCoffee(id);
    },
  );

  // ---------------------------------------------------------------------------
  // Sorten-Foto — genau eines je Sorte.
  //
  // Upload kommt als Base64 in JSON: das spart @fastify/multipart als weitere
  // Abhaengigkeit, und die Nutzlast ist klein, weil der Browser das Bild vor
  // dem Senden verkleinert (auf der Box gibt es keinen Bildskalierer, und mit
  // 1 GB RAM soll da auch keiner hin).
  //
  // ⚠ Der behauptete Content-Type des Clients wird ignoriert. Der Typ kommt
  // aus den Magic Bytes — sonst waere "image/jpeg" auf beliebigem Inhalt eine
  // Einladung, den Browser spaeter etwas anderes rendern zu lassen.
  // ---------------------------------------------------------------------------
  app.get(
    "/api/coffees/:id/image",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return reply.status(400).send({ error: "Invalid id" });
      const img = coffeeRepo.getImage(id);
      if (!img) return reply.status(404).send({ error: "No image" });
      // Immutable ist sicher, weil die URL den Zeitstempel als ?v= traegt.
      return reply
        .header("Content-Type", img.mime)
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .send(img.bytes);
    },
  );

  app.put(
    "/api/coffees/:id/image",
    { bodyLimit: 2_000_000 },
    async (req: FastifyRequest<{ Params: { id: string }; Body: unknown }>, reply: FastifyReply) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return reply.status(400).send({ error: "Invalid id" });
      if (!coffeeRepo.findById(id)) return reply.status(404).send({ error: "Coffee not found" });

      const body = (req.body ?? {}) as Record<string, unknown>;
      const data = body["data"];
      if (typeof data !== "string" || data === "") {
        return reply.status(400).send({ error: "Body must include { data: base64 }" });
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(data, "base64");
      } catch {
        return reply.status(400).send({ error: "data is not valid base64" });
      }
      if (bytes.length === 0) return reply.status(400).send({ error: "data is empty" });
      if (bytes.length > MAX_IMAGE_BYTES) {
        return reply
          .status(413)
          .send({ error: `Image too large (max ${Math.round(MAX_IMAGE_BYTES / 1024)} kB)` });
      }
      const mime = sniffImageMime(bytes);
      if (!mime) return reply.status(400).send({ error: "Only JPEG, PNG or WebP" });

      coffeeRepo.putImage(id, mime, bytes);
      const stored = coffeeRepo.getImage(id)!;
      return { ok: true, mime, bytes: bytes.length, imageUpdatedAt: stored.updatedAt };
    },
  );

  app.delete(
    "/api/coffees/:id/image",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return reply.status(400).send({ error: "Invalid id" });
      if (!coffeeRepo.deleteImage(id)) return reply.status(404).send({ error: "No image" });
      return reply.status(204).send();
    },
  );

  // POST /api/coffees
  app.post(
    "/api/coffees",
    async (req: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = body["name"];
      if (typeof name !== "string" || name.trim() === "") {
        return reply.status(400).send({ error: "name is required" });
      }
      const btErr = brewTypeError(body);
      if (btErr) return reply.status(400).send({ error: btErr });
      const rErr = ratingError(body);
      if (rErr) return reply.status(400).send({ error: rErr });

      // §3.4b / §3i — optional first roasting created atomically with the Sorte.
      const fr = body["firstRoasting"];
      if (fr === undefined || fr === null) {
        // Legacy Sorte-only create (unchanged path).
        const id = coffeeRepo.insert(body as unknown as Parameters<SqliteCoffeeRepo["insert"]>[0]);
        return reply.status(201).send({ id, name });
      }
      if (typeof fr !== "object" || Array.isArray(fr)) {
        return reply.status(400).send({ error: "firstRoasting must be an object" });
      }
      const built = buildFirstRoasting(0, name.trim(), fr as Record<string, unknown>);
      if ("error" in built) return reply.status(400).send({ error: built.error });

      // Atomic: Sorte + Röstung in one transaction. node:sqlite has no
      // .transaction() — explicit BEGIN/COMMIT/ROLLBACK on the shared
      // connection, exactly like the merge path above.
      const db = getDb();
      db.exec("BEGIN");
      try {
        const coffeeId = coffeeRepo.insert(
          body as unknown as Parameters<SqliteCoffeeRepo["insert"]>[0],
        );
        beanRepo.insert({ ...built.create, coffeeId });
        db.exec("COMMIT");
        return reply.status(201).send({ id: coffeeId, name });
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  );

  // POST /api/coffees/:id/roastings — "Nachkaufen": new roasting inheriting the
  // coffee's master data. Body: roasting fields only (roastDate, bagSizeG,
  // pricePerBagEur, remainingG?, status?). New roastings are NOT auto-activated.
  app.post(
    "/api/coffees/:id/roastings",
    async (req: FastifyRequest<{ Params: { id: string }; Body: unknown }>, reply: FastifyReply) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return reply.status(400).send({ error: "Invalid id" });
      if (!coffeeRepo.findById(id)) return reply.status(404).send({ error: "Coffee not found" });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const create: BeanCreate = {
        // name is required by the type but master data lives on the coffee; the
        // bean insert ignores it. Use the coffee's name for clarity in logs.
        name: coffeeRepo.findById(id)?.name ?? "",
        coffeeId: id,
        roastDate: typeof body["roastDate"] === "string" ? (body["roastDate"] as string) : null,
        bagSizeG: typeof body["bagSizeG"] === "number" ? (body["bagSizeG"] as number) : null,
        pricePerBagEur: typeof body["pricePerBagEur"] === "number" ? (body["pricePerBagEur"] as number) : null,
        remainingG:
          typeof body["remainingG"] === "number"
            ? (body["remainingG"] as number)
            : typeof body["bagSizeG"] === "number"
              ? (body["bagSizeG"] as number) // default remaining = full bag
              : null,
        status: "stock", // §3g: new roastings start in stock, not active (is_active=0)
        rating: null,
      };
      const beanId = beanRepo.insert(create);
      return reply.status(201).send({ id: beanId, coffeeId: id });
    },
  );

  // POST /api/coffees/:id/merge — move all roastings of :id onto target, delete :id.
  app.post(
    "/api/coffees/:id/merge",
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { targetId?: unknown } }>,
      reply: FastifyReply,
    ) => {
      const sourceId = parseInt(req.params.id, 10);
      if (isNaN(sourceId)) return reply.status(400).send({ error: "Invalid id" });
      const targetId = req.body?.targetId;
      if (typeof targetId !== "number" || !Number.isInteger(targetId)) {
        return reply.status(400).send({ error: "targetId (integer) is required" });
      }
      if (targetId === sourceId) return reply.status(400).send({ error: "targetId must differ from source" });
      if (!coffeeRepo.findById(sourceId)) return reply.status(404).send({ error: "Source coffee not found" });
      if (!coffeeRepo.findById(targetId)) return reply.status(404).send({ error: "Target coffee not found" });

      const db = getDb();
      db.exec("BEGIN");
      try {
        // Re-point every roasting, then delete the now-empty source coffee.
        db.prepare("UPDATE bean SET coffee_id = ?, updated_at = ? WHERE coffee_id = ?").run(
          targetId,
          Date.now(),
          sourceId,
        );
        db.prepare("DELETE FROM coffee WHERE id = ?").run(sourceId);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      const moved = coffeeRepo.findById(targetId);
      return { ok: true, targetId, roastingCount: moved?.roastingCount ?? null };
    },
  );

  // PUT /api/coffees/:id
  app.put(
    "/api/coffees/:id",
    async (req: FastifyRequest<{ Params: { id: string }; Body: unknown }>, reply: FastifyReply) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return reply.status(400).send({ error: "Invalid id" });
      if (!coffeeRepo.findById(id)) return reply.status(404).send({ error: "Coffee not found" });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const btErr = brewTypeError(body);
      if (btErr) return reply.status(400).send({ error: btErr });
      const rErr = ratingError(body);
      if (rErr) return reply.status(400).send({ error: rErr });
      coffeeRepo.update(id, body as unknown as Parameters<SqliteCoffeeRepo["update"]>[1]);
      return { ok: true };
    },
  );

  // DELETE /api/coffees/:id — only when no roastings remain (ON DELETE RESTRICT).
  app.delete(
    "/api/coffees/:id",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return reply.status(400).send({ error: "Invalid id" });
      if (!coffeeRepo.findById(id)) return reply.status(404).send({ error: "Coffee not found" });
      // Roestungen duerfen mitgehen, solange an keiner ein Bezug haengt: dann
      // geht nichts von der Historie verloren. Sobald ein Bezug daran haengt,
      // bleibt es bei der Ablehnung — er wuerde sonst seine Bohne verlieren
      // (shot.bean_id ON DELETE SET NULL).
      const shots = coffeeRepo.shotCount(id);
      if (shots > 0) {
        return reply.status(409).send({
          error: `Sorte hat ${shots} Bezüge an ihren Röstungen — zuerst verschieben/zusammenführen`,
        });
      }
      const roastings = coffeeRepo.roastingCount(id);
      if (roastings > 0) coffeeRepo.deleteWithRoastings(id);
      else coffeeRepo.delete(id);
      return { ok: true, deletedRoastings: roastings };
    },
  );
}
