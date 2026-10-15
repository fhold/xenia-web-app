/**
 * Profile routes — Phase 1 Step 4b.
 *
 * GET    /api/profiles                  — list all profiles (sorted)
 * GET    /api/profiles/:id              — single profile
 * POST   /api/profiles                  — create profile
 * PUT    /api/profiles/:id              — update profile
 * DELETE /api/profiles/:id              — delete profile
 * POST   /api/profiles/favorites/order  — reorder favorites
 */

import type { FastifyInstance } from "fastify";
import type { ProfileRepo } from "../db/profile-repo.js";
import type { ScriptRepo } from "../db/script-repo.js";
import type {
  ApiResponse,
  BrewProfile,
  ProfileCreate,
  ProfileUpdate,
} from "../../../shared/src/types.js";
import { parseTargetTempC } from "../../../shared/src/profile-temp.js";
import { validateBrewProfile } from "../../../shared/src/brew-steps.js";

function isPositiveYield(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** The fields the invariants below are about — for a create that is the body,
 *  for an update the patch overlaid on the stored profile. */
interface EffectiveProfile {
  scriptIdSingle?: number | null;
  brewSteps?: BrewProfile | null;
  brewStepsDouble?: BrewProfile | null;
  yieldTargetSingleG?: number | null;
  yieldTargetDoubleG?: number | null;
}

/**
 * M-1: the invariants of a *stored* profile, checked on the merged end state.
 * Create enforced part of this, update enforced almost none — so a partial
 * update could leave a profile that no start path accepts, and a malformed step
 * sequence only surfaced when the driver was already commanding the pump.
 *
 * Deliberately "at least one execution mode", not "exactly one": a profile that
 * carries both a script and a step sequence is pending its own re-spec.
 *
 * @returns the error message, or null when the profile is sound.
 */
function checkProfileInvariants(p: EffectiveProfile): string | null {
  if (p.scriptIdSingle == null && p.brewSteps == null) {
    return "A profile needs an execution mode: a Xenia script (scriptIdSingle) or a step sequence (brewSteps)";
  }
  // Every configured flow slot is weight-stopped — no yield target, no BBW stop.
  if (p.brewSteps != null && !isPositiveYield(p.yieldTargetSingleG)) {
    return "yieldTargetSingleG (>0) is required when a step sequence is set";
  }
  if (p.brewStepsDouble != null && !isPositiveYield(p.yieldTargetDoubleG)) {
    return "yieldTargetDoubleG (>0) is required when a 2× sequence is set";
  }
  for (const [field, bp] of [
    ["brewSteps", p.brewSteps],
    ["brewStepsDouble", p.brewStepsDouble],
  ] as const) {
    if (bp == null) continue;
    const check = validateBrewProfile(bp);
    if (!check.ok) return `${field}: ${check.error}`;
  }
  return null;
}

export function registerProfileRoutes(
  app: FastifyInstance,
  profileRepo: ProfileRepo,
  scriptRepo: ScriptRepo,
  onProfilesChanged: () => void,
): void {
  // ---------------------------------------------------------------------------
  // GET /api/profiles
  // ---------------------------------------------------------------------------
  app.get("/api/profiles", async () => {
    return profileRepo.listAll();
  });

  // ---------------------------------------------------------------------------
  // POST /api/profiles/favorites/order
  // Must be registered BEFORE /:id so Fastify doesn't match "favorites" as id
  // ---------------------------------------------------------------------------
  app.post("/api/profiles/favorites/order", async (req, reply) => {
    const { ids } = req.body as { ids: unknown };
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "number")) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: "ids must be an array of numbers" };
      return res;
    }
    profileRepo.reorderFavorites(ids as number[]);
    onProfilesChanged();
    const res: ApiResponse = { ok: true };
    return res;
  });

  // ---------------------------------------------------------------------------
  // GET /api/profiles/:id
  // ---------------------------------------------------------------------------
  app.get("/api/profiles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const numId = parseInt(id, 10);
    if (Number.isNaN(numId)) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: "Invalid profile ID" };
      return res;
    }
    const profile = profileRepo.findById(numId);
    if (!profile) {
      reply.status(404);
      const res: ApiResponse = { ok: false, error: `Profile ${id} not found` };
      return res;
    }
    return profile;
  });

  // ---------------------------------------------------------------------------
  // POST /api/profiles
  // ---------------------------------------------------------------------------
  app.post("/api/profiles", async (req, reply) => {
    const body = req.body as ProfileCreate;

    if (!body.name?.trim()) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: "name is required" };
      return res;
    }

    // A flow-driven profile (brewSteps present) needs no Xenia script — its
    // single script id may be null; checkProfileInvariants covers that case.
    // When a script id IS given, validate it regardless of profile kind.
    if (body.scriptIdSingle !== null && body.scriptIdSingle !== undefined
        && !scriptRepo.findById(body.scriptIdSingle)) {
      reply.status(400);
      const res: ApiResponse = {
        ok: false,
        error: `Script ${body.scriptIdSingle} not found`,
      };
      return res;
    }

    // Validate scriptIdDouble if provided (and not explicitly null)
    if (body.scriptIdDouble !== undefined && body.scriptIdDouble !== null) {
      if (!scriptRepo.findById(body.scriptIdDouble)) {
        reply.status(400);
        const res: ApiResponse = {
          ok: false,
          error: `Double script ${body.scriptIdDouble} not found`,
        };
        return res;
      }
    }

    // Validate optional target brew temp (PT-1) — null/absent or 70–110 °C.
    // Mirrors the double yield-override validation; rejects typos like 960.
    const tempParse = parseTargetTempC(body.targetTempC);
    if (!tempParse.ok) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: tempParse.error };
      return res;
    }

    const invariant = checkProfileInvariants(body);
    if (invariant) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: invariant };
      return res;
    }

    const id = profileRepo.insert(body);
    const created = profileRepo.findById(id);
    onProfilesChanged();
    return created;
  });

  // ---------------------------------------------------------------------------
  // PUT /api/profiles/:id
  // ---------------------------------------------------------------------------
  app.put("/api/profiles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const numId = parseInt(id, 10);
    if (Number.isNaN(numId)) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: "Invalid profile ID" };
      return res;
    }

    const existing = profileRepo.findById(numId);
    if (!existing) {
      reply.status(404);
      const res: ApiResponse = { ok: false, error: `Profile ${id} not found` };
      return res;
    }

    const patch = req.body as ProfileUpdate;

    // Validate scriptIdSingle if provided and non-null. null = clear the script
    // (a profile becoming flow-driven), always allowed.
    if (patch.scriptIdSingle !== undefined && patch.scriptIdSingle !== null) {
      if (!scriptRepo.findById(patch.scriptIdSingle)) {
        reply.status(400);
        const res: ApiResponse = {
          ok: false,
          error: `Script ${patch.scriptIdSingle} not found`,
        };
        return res;
      }
    }

    // Validate scriptIdDouble if provided and non-null (null = clear, always allowed)
    if (patch.scriptIdDouble !== undefined && patch.scriptIdDouble !== null) {
      if (!scriptRepo.findById(patch.scriptIdDouble)) {
        reply.status(400);
        const res: ApiResponse = {
          ok: false,
          error: `Double script ${patch.scriptIdDouble} not found`,
        };
        return res;
      }
    }

    // Validate target brew temp only when the field is present (PT-1). Absent =
    // unchanged; an explicit null clears it. Never silently null on a bad value.
    if (patch.targetTempC !== undefined) {
      const tempParse = parseTargetTempC(patch.targetTempC);
      if (!tempParse.ok) {
        reply.status(400);
        const res: ApiResponse = { ok: false, error: tempParse.error };
        return res;
      }
    }

    // Check the merged end state (patch overlaid on the stored profile), not the
    // patch alone — a partial update must not be able to leave the profile in a
    // state no start path accepts.
    const pick = <K extends keyof ProfileUpdate>(key: K) =>
      patch[key] !== undefined ? patch[key] : (existing[key as keyof typeof existing] as ProfileUpdate[K]);
    const invariant = checkProfileInvariants({
      scriptIdSingle: pick("scriptIdSingle"),
      brewSteps: pick("brewSteps"),
      brewStepsDouble: pick("brewStepsDouble"),
      yieldTargetSingleG: pick("yieldTargetSingleG"),
      yieldTargetDoubleG: pick("yieldTargetDoubleG"),
    });
    if (invariant) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: invariant };
      return res;
    }

    profileRepo.update(numId, patch);
    onProfilesChanged();
    return profileRepo.findById(numId);
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/profiles/:id
  // ---------------------------------------------------------------------------
  app.delete("/api/profiles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const numId = parseInt(id, 10);
    if (Number.isNaN(numId)) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: "Invalid profile ID" };
      return res;
    }
    if (!profileRepo.findById(numId)) {
      reply.status(404);
      const res: ApiResponse = { ok: false, error: `Profile ${id} not found` };
      return res;
    }
    profileRepo.delete(numId);
    onProfilesChanged();
    const res: ApiResponse = { ok: true };
    return res;
  });
}
