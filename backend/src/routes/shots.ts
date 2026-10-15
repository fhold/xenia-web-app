/**
 * Shot routes — Phase 1 Step 5.
 *
 * GET  /api/shots              — list shots (limit, offset, category query params)
 * GET  /api/shots/active       — currently recording shot (or 404)
 * GET  /api/shots/:id          — shot + samples (ShotDetail)
 * POST /api/shots/:id/stop     — manual stop: mark + send scriptStop to Xenia
 */

import type { FastifyInstance } from "fastify";
import type { XeniaClient } from "../xenia/client.js";
import type { ShotRepo, ShotListFilter } from "../db/shot-repo.js";
import {
  GHOST_GRID_MS,
  gridPointsFor,
  resampleToGrid,
  type GhostBasis,
  type ShotGhosts,
} from "../../../shared/src/shot-ghosts.js";
import type { BeanRepo } from "../db/bean-repo.js";
import type { ProfileRepo } from "../db/profile-repo.js";
import type { ScriptRepo } from "../db/script-repo.js";
import type { BestBrewRepo } from "../db/best-brew-repo.js";
import type { ShotRecorder } from "../shots/recorder.js";
import type { FlowHoldDriver } from "../xenia/flow-hold-driver.js";
import { XeniaError } from "../xenia/client.js";
import { canonicalBrewDef } from "../db/brew-def.js";
import type {
  ApiResponse,
  BrewDefInfo,
  Shot,
  ShotDetail,
  ShotListResponse,
  ShotSortKey,
  ShotUpdate,
} from "../../../shared/src/types.js";
import { TASTE_TAGS } from "../../../shared/src/types.js";

/** How many ghosts a client gets by default / at most, and the stub cutoff. */
const GHOST_DEFAULT_LIMIT = 20;
const GHOST_MAX_LIMIT = 50;
const GHOST_MIN_SAMPLES = 10;

export function registerShotRoutes(
  app: FastifyInstance,
  client: XeniaClient,
  shotRepo: ShotRepo,
  recorder: ShotRecorder,
  beanRepo: BeanRepo,
  profileRepo: ProfileRepo,
  scriptRepo: ScriptRepo,
  bestBrewRepo: BestBrewRepo,
  broadcastShotUpdated: (shot: Shot) => void,
  driver: FlowHoldDriver,
): void {
  // SO-1: live-resolve a shot's script (profile → script id by size → content),
  // only if it still exists (not orphaned). null → frontend shows no overlay.
  const resolveCurrentScriptContent = (shot: Shot): string | null => {
    if (shot.profileId === null) return null;
    const profile = profileRepo.findById(shot.profileId);
    if (!profile) return null;
    const scriptId =
      shot.shotSize === "single" ? profile.scriptIdSingle : profile.scriptIdDouble;
    if (scriptId === null || scriptId === undefined) return null;
    const script = scriptRepo.findById(scriptId);
    if (!script || script.orphanedAt !== null) return null;
    return script.content;
  };

  /** The definition the shot's profile would run TODAY, for the isCurrent check. */
  const currentDefContent = (shot: Shot, kind: "script" | "steps"): string | null => {
    if (kind === "script") return resolveCurrentScriptContent(shot);
    if (shot.profileId === null) return null;
    const profile = profileRepo.findById(shot.profileId);
    if (!profile) return null;
    const steps =
      shot.shotSize === "single"
        ? profile.brewSteps
        : (profile.brewStepsDouble ?? profile.brewSteps);
    return steps ? JSON.stringify(steps) : null;
  };

  /**
   * The frozen brew definition of a shot. Shots recorded before the snapshot
   * existed have no hash — for those the commanded overlay still falls back to
   * the script as it reads today, which is the best that can be said.
   */
  const brewDefInfo = (shot: Shot): BrewDefInfo | null => {
    if (shot.brewDefHash === null) return null;
    const def = shotRepo.getBrewDef(shot.brewDefHash);
    if (def === null) return null;
    const current = currentDefContent(shot, def.kind);
    return {
      hash: def.hash,
      kind: def.kind,
      content: def.content,
      isCurrent: current === null ? null : canonicalBrewDef(def.kind, current) === def.content,
    };
  };

  /** Token string for the commanded overlay: what THIS shot ran, else today's. */
  const overlayScriptContent = (shotId: number): string | null => {
    const shot = shotRepo.findById(shotId);
    if (!shot) return null;
    const def = brewDefInfo(shot);
    if (def !== null && def.kind === "script") return def.content;
    return resolveCurrentScriptContent(shot);
  };
  // ---------------------------------------------------------------------------
  // GET /api/shots — history list with filter, sort and pagination
  // Query: limit (≤100, default 30), offset, sort, category (default 'brew'),
  //        bean_id, grinder_id, profile_id, rating, start_date, end_date
  // ---------------------------------------------------------------------------
  app.get("/api/shots", async (req) => {
    const q = req.query as Record<string, string | undefined>;

    const limitRaw = q.limit ? parseInt(q.limit, 10) : 30;
    const limit = Number.isNaN(limitRaw) ? 30 : Math.min(Math.max(limitRaw, 1), 100);
    const offsetRaw = q.offset ? parseInt(q.offset, 10) : 0;
    const offset = Number.isNaN(offsetRaw) ? 0 : Math.max(offsetRaw, 0);

    const sort = (["date_desc", "date_asc", "rating", "bean"].includes(q.sort ?? "")
      ? q.sort
      : "date_desc") as ShotSortKey;

    const category =
      q.category === "maintenance" || q.category === "all" || q.category === "brew"
        ? q.category
        : "brew";

    const numParam = (v: string | undefined): number | undefined => {
      if (!v) return undefined;
      const n = parseInt(v, 10);
      return Number.isNaN(n) ? undefined : n;
    };

    const filter: ShotListFilter = {
      limit,
      offset,
      sort,
      category,
      beanId: numParam(q.bean_id),
      grinderId: numParam(q.grinder_id),
      profileId: numParam(q.profile_id),
    };

    if (q.rating) {
      const r = parseInt(q.rating, 10);
      if (Number.isInteger(r) && r >= 1 && r <= 5) filter.rating = r;
    }
    if (q.start_date) {
      const ms = Date.parse(q.start_date);
      if (!Number.isNaN(ms)) filter.startMs = ms;
    }
    if (q.end_date) {
      const ms = Date.parse(q.end_date);
      // Date-only input → include the whole day (start-of-day + 24h - 1ms).
      if (!Number.isNaN(ms)) filter.endMs = ms + 86_399_999;
    }

    const { shots, total } = shotRepo.listShotsFiltered(filter);
    const res: ShotListResponse = {
      shots,
      total,
      hasMore: offset + shots.length < total,
    };
    return res;
  });

  // ---------------------------------------------------------------------------
  // GET /api/shots/active — currently recording shot
  // Must be before /:id so Fastify matches "active" statically
  // ---------------------------------------------------------------------------
  app.get("/api/shots/active", async (_req, reply) => {
    const shot = shotRepo.findActive();
    if (!shot) {
      reply.status(404);
      const res: ApiResponse = { ok: false, error: "No active shot" };
      return res;
    }
    return shot;
  });

  // ---------------------------------------------------------------------------
  // GET /api/shots/recent?limit=5 — recent brew shots for the dashboard
  // Maintenance shots are excluded. Must be before /:id (static match).
  // ---------------------------------------------------------------------------
  app.get("/api/shots/recent", async (req) => {
    const q = req.query as { limit?: string };
    const parsed = q.limit ? parseInt(q.limit, 10) : 5;
    // Clamp to a sane range; fall back to 5 on garbage input.
    const limit = Number.isNaN(parsed) ? 5 : Math.min(Math.max(parsed, 1), 20);
    return shotRepo.listRecentBrew(limit);
  });

  // ---------------------------------------------------------------------------
  // GET /api/shots/preshot-defaults?beanId=&grinderId= — pre-shot prefill
  //
  // Cascade (§3.4b — extends Step 9 with a Coffee/Sorte stage so a freshly
  // re-purchased roasting with no shots yet still prefills from the same coffee):
  //   grindSetting / grinderRpm (grinder-specific — same scale across roastings):
  //     1. roasting + grinder (exact)
  //     2. NEW: same coffee (other roasting) + SAME grinder
  //     3. grinder (any coffee)
  //     4. null
  //   doseG (coffee property — grinder-independent):
  //     1. roasting + grinder (exact)
  //     2. NEW: same coffee (any grinder)
  //     3. null
  // Source of each value is the newest matching shot (started_at DESC). The
  // coffee-grind stage requires the SAME grinder because grind numbers are
  // grinder-specific (DF83v 17 ≠ DF64 17).
  //
  // Must be before /:id so Fastify matches "preshot-defaults" statically.
  // ---------------------------------------------------------------------------
  app.get("/api/shots/preshot-defaults", async (req) => {
    const q = req.query as { beanId?: string; grinderId?: string; profileId?: string };
    const explicitBeanId    = q.beanId    ? parseInt(q.beanId, 10)    : NaN;
    const explicitGrinderId = q.grinderId ? parseInt(q.grinderId, 10) : NaN;
    const profileId         = q.profileId ? parseInt(q.profileId, 10) : NaN;

    // Bean: an explicit beanId (user picked in the dialog / repeat flow) wins;
    // otherwise the bean last brewed with THIS profile — the per-profile default
    // for a fresh profile start (fav chip / profile overview).
    const lastProfileShot = !Number.isNaN(profileId)
      ? shotRepo.findLast({ profileId })
      : undefined;
    const beanId = !Number.isNaN(explicitBeanId)
      ? explicitBeanId
      : (lastProfileShot?.beanId ?? NaN);
    const hasBean = !Number.isNaN(beanId);

    // Grinder comes VIA the bean: an explicit grinderId wins; otherwise the
    // grinder last used with the resolved bean. Grind numbers are grinder-
    // specific, so the grinder belongs to the bean, not the profile.
    const lastBeanShot = hasBean ? shotRepo.findLast({ beanId }) : undefined;
    const grinderId = !Number.isNaN(explicitGrinderId)
      ? explicitGrinderId
      : (lastBeanShot?.grinderId ?? NaN);
    const hasGrinder = !Number.isNaN(grinderId);

    // The coffee (Sorte) this roasting belongs to — drives the new stage.
    const coffeeId = hasBean ? (beanRepo.findById(beanId)?.coffeeId ?? null) : null;

    let grindSetting: number | null = null;
    let grinderRpm: number | null = null;
    let doseG: number | null = null;

    // grind / rpm — pick the source shot by stage precedence, then take its
    // values (even if null) and stop. Stage 1+2 need a grinder.
    let gShot = hasBean && hasGrinder ? shotRepo.findLast({ beanId, grinderId }) : undefined;
    if (!gShot && coffeeId !== null && hasGrinder) {
      gShot = shotRepo.findLastByCoffee({ coffeeId, grinderId });
    }
    if (!gShot && hasGrinder) {
      gShot = shotRepo.findLast({ grinderId });
    }
    if (gShot) {
      grindSetting = gShot.grindSetting;
      grinderRpm = gShot.grinderRpm;
    }

    // dose — exact roasting+grinder, then same coffee (any grinder). Both stages
    // skip shots that have no dose recorded: otherwise a single shot saved
    // without one shadows every older shot that has it, and the prefill stays
    // empty from then on — which then produces the next dose-less shot.
    let dShot = hasBean && hasGrinder
      ? shotRepo.findLast({ beanId, grinderId, withDose: true })
      : undefined;
    if (!dShot && coffeeId !== null) {
      dShot = shotRepo.findLastByCoffee({ coffeeId, withDose: true });
    }
    if (dShot) {
      doseG = dShot.doseG;
    }

    return {
      suggestedBeanId: hasBean ? beanId : null,
      suggestedGrinderId: hasGrinder ? grinderId : null,
      grindSetting,
      grinderRpm,
      doseG,
    };
  });

  // ---------------------------------------------------------------------------
  // GET /api/shots/:id — shot detail (shot + samples)
  // ---------------------------------------------------------------------------
  app.get("/api/shots/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const numId = parseInt(id, 10);
    if (Number.isNaN(numId)) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: "Invalid shot ID" };
      return res;
    }
    const shot = shotRepo.findById(numId);
    if (!shot) {
      reply.status(404);
      const res: ApiResponse = { ok: false, error: `Shot ${id} not found` };
      return res;
    }
    const samples = shotRepo.listSamples(numId);
    const detail: ShotDetail = {
      shot,
      samples,
      isBestBrew: bestBrewRepo.isBestBrewShot(numId),
      stages: shotRepo.listStages(numId),
      brewSteps: shotRepo.getBrewStepsSnapshot(numId),
      brewDef: brewDefInfo(shot),
    };
    return detail;
  });

  // ---------------------------------------------------------------------------
  // GET /api/shots/:id/samples — sample rows only (history detail chart)
  // ---------------------------------------------------------------------------
  app.get("/api/shots/:id/samples", async (req, reply) => {
    const numId = parseInt((req.params as { id: string }).id, 10);
    if (Number.isNaN(numId)) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: "Invalid shot ID" };
      return res;
    }
    // SO-1: include the live-resolved script content for the commanded overlay.
    // Flow-Hold: include the stage transitions + brew-steps snapshot for the
    // Soll-Kurve (empty/null for script/execute shots).
    const shot = shotRepo.findById(numId);
    return {
      samples: shotRepo.listSamples(numId),
      scriptContent: overlayScriptContent(numId),
      stages: shotRepo.listStages(numId),
      brewSteps: shotRepo.getBrewStepsSnapshot(numId),
      brewDef: shot ? brewDefInfo(shot) : null,
    };
  });

  // ---------------------------------------------------------------------------
  // PUT /api/shots/:id — edit a shot's editable fields (bean, grinder, grind,
  // rpm, dose, tds, rating, notes). Non-editable fields are ignored by the repo.
  // ---------------------------------------------------------------------------
  app.put("/api/shots/:id", async (req, reply) => {
    const numId = parseInt((req.params as { id: string }).id, 10);
    if (Number.isNaN(numId)) {
      // NB: do NOT `await reply.status(...)` — awaiting the reply deadlocks in
      // Fastify v5 (it resolves only after the response is sent). Set + return.
      return reply.status(400).send({ ok: false, error: "Invalid shot ID" } as ApiResponse);
    }
    const body = (req.body ?? {}) as ShotUpdate;

    // Validate the rating dimensions (all optional; null clears a field).
    const isScore = (v: unknown): boolean =>
      v === null || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5);
    const bad =
      (body.rating !== undefined && !isScore(body.rating)) ||
      (body.acidity !== undefined && !isScore(body.acidity)) ||
      (body.bitterness !== undefined && !isScore(body.bitterness)) ||
      (body.extractionUnder !== undefined && typeof body.extractionUnder !== "boolean") ||
      (body.extractionOver !== undefined && typeof body.extractionOver !== "boolean") ||
      (body.channeling !== undefined && typeof body.channeling !== "boolean") ||
      (body.channelingSeverity !== undefined &&
        body.channelingSeverity !== null &&
        !["light", "strong"].includes(body.channelingSeverity)) ||
      // Widerspruch: Staerke angegeben, aber Channeling ausdruecklich aus.
      (body.channeling === false &&
        body.channelingSeverity !== undefined &&
        body.channelingSeverity !== null) ||
      (body.grindNote !== undefined &&
        body.grindNote !== null &&
        !["finer", "ok", "coarser"].includes(body.grindNote)) ||
      (body.tasteTags !== undefined &&
        body.tasteTags !== null &&
        (!Array.isArray(body.tasteTags) ||
          !body.tasteTags.every((t) => (TASTE_TAGS as readonly string[]).includes(t))));
    if (bad) {
      return reply.status(400).send({ ok: false, error: "Invalid rating value" } as ApiResponse);
    }
    if (!shotRepo.updateShot(numId, body)) {
      return reply.status(404).send({ ok: false, error: `Shot ${numId} not found` } as ApiResponse);
    }
    // Live cross-client sync: push the updated shot so other clients (e.g. the
    // tablet showing the post-shot review) refresh without a manual reload.
    const updated = shotRepo.findById(numId);
    if (updated) broadcastShotUpdated(updated);
    const res: ApiResponse = { ok: true };
    return res;
  });

  // ---------------------------------------------------------------------------
  // GET /api/shots/bean-labels — bisher benutzte Freitext-Bohnen fuers Autocomplete.
  // Statischer Pfad gewinnt gegen /:id (wie /api/coffees/match).
  // ---------------------------------------------------------------------------
  app.get("/api/shots/bean-labels", async () => shotRepo.beanLabelSuggestions());

  // ---------------------------------------------------------------------------
  // GET /api/shots/:id/ghosts — past shots of the same brew, on a common grid
  //
  // Basis: the frozen brew definition when the shot has one (provably the same
  // ablauf), else the profile id. brew_def_hash is not backfilled, so older
  // shots fall back to the profile and the response says which it used — the
  // legend has to name the basis, otherwise the cloud claims a precision it
  // does not have.
  // ---------------------------------------------------------------------------
  app.get("/api/shots/:id/ghosts", async (req, reply) => {
    const numId = parseInt((req.params as { id: string }).id, 10);
    if (Number.isNaN(numId)) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: "Invalid shot ID" };
      return res;
    }
    const shot = shotRepo.findById(numId);
    if (!shot) {
      reply.status(404);
      const res: ApiResponse = { ok: false, error: "Shot not found" };
      return res;
    }

    const q = req.query as Record<string, string | undefined>;
    const limitRaw = q.limit ? parseInt(q.limit, 10) : GHOST_DEFAULT_LIMIT;
    const limit = Number.isNaN(limitRaw)
      ? GHOST_DEFAULT_LIMIT
      : Math.min(Math.max(limitRaw, 1), GHOST_MAX_LIMIT);

    const basis: GhostBasis = shot.brewDefHash !== null ? "brewdef" : "profile";
    const key = basis === "brewdef" ? shot.brewDefHash! : shot.profileId;
    if (key === null) {
      const empty: ShotGhosts = { basis, gridMs: GHOST_GRID_MS, shots: [] };
      return empty;
    }

    const ids = shotRepo.listGhostCandidates({
      excludeShotId: numId,
      basis,
      key,
      minSamples: GHOST_MIN_SAMPLES,
      limit,
      shotSize: shot.shotSize,
    });
    const samplesById = shotRepo.listGhostSamples(ids);

    let maxElapsed = 0;
    for (const rows of samplesById.values()) {
      const last = rows[rows.length - 1];
      if (last && last.elapsedMs > maxElapsed) maxElapsed = last.elapsedMs;
    }
    const gridPoints = gridPointsFor(maxElapsed);

    const result: ShotGhosts = {
      basis,
      gridMs: GHOST_GRID_MS,
      shots: ids
        .map((id) => {
          const rows = samplesById.get(id);
          if (!rows) return null;
          const series = resampleToGrid(rows, gridPoints);
          return { id, pressure: series.pressure, flow: series.flow };
        })
        .filter((g): g is NonNullable<typeof g> => g !== null),
    };
    return result;
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/shots/:id — hard-delete a shot (samples cascade). 204 on
  // success, 404 if it doesn't exist.
  // ---------------------------------------------------------------------------
  app.delete("/api/shots/:id", async (req, reply) => {
    const numId = parseInt((req.params as { id: string }).id, 10);
    if (Number.isNaN(numId)) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: "Invalid shot ID" };
      return res;
    }
    if (!shotRepo.deleteShot(numId)) {
      reply.status(404);
      const res: ApiResponse = { ok: false, error: `Shot ${numId} not found` };
      return res;
    }
    reply.status(204).send();
  });

  // ---------------------------------------------------------------------------
  // POST /api/shots/:id/stop — manual stop
  //
  // 1. Validates the shot is currently active
  // 2. Marks recorder as manual stop
  // 3. Sends scriptStop to Xenia — triggers the drain phase
  //    The recorder finalizes when it sees MA_STATUS=4 (DRAINING)
  // ---------------------------------------------------------------------------
  app.post("/api/shots/:id/stop", async (req, reply) => {
    const { id } = req.params as { id: string };
    const numId = parseInt(id, 10);
    if (Number.isNaN(numId)) {
      reply.status(400);
      const res: ApiResponse = { ok: false, error: "Invalid shot ID" };
      return res;
    }

    // Confirm this shot is the currently active one
    if (recorder.activeShotId !== numId) {
      reply.status(409);
      const res: ApiResponse = {
        ok: false,
        error: `Shot ${id} is not currently active`,
      };
      return res;
    }

    // A flow-hold drive is app-driven: scripts/stop does not end it, the driver
    // would keep commanding the pump until BBW or the watchdog fires. Only the
    // driver knows its exit sequence (paddle/stop → pumppower=0 → action "1" →
    // SB cleanup), so the one Stop button in the UI routes here.
    if (driver.isActive()) {
      driver.requestStop();
      const res: ApiResponse = { ok: true };
      return res;
    }

    try {
      // Mark stop mode before sending command — recorder checks this on next finalize
      recorder.markManualStop(numId);
      await client.scriptStop();
      const res: ApiResponse = { ok: true };
      return res;
    } catch (err) {
      // The machine never took the stop — take the mark back, otherwise a later
      // natural script end of this shot would be booked as 'manual'.
      recorder.clearManualStop(numId);
      reply.status(502);
      const msg = err instanceof XeniaError ? err.message : String(err);
      const res: ApiResponse = { ok: false, error: msg };
      return res;
    }
  });
}
