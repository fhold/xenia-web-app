/**
 * Flow-hold drive routes (Consistent-Flow, Phase 1).
 *
 * POST /api/drive/consistent-flow/start — start an app-side paddle-driven shot
 * POST /api/drive/consistent-flow/stop  — abort a running drive (normal exit)
 *
 * The drive is associated with a profile purely for recording/history: it uses
 * the profile's script id as the shot's script_id and its yield target, but does
 * NOT execute that Xenia script — extraction is driven via the paddle API.
 */

import type { FastifyInstance } from "fastify";
import type { ProfileRepo } from "../db/profile-repo.js";
import type { SettingsRepo } from "../db/settings-repo.js";
import type { ShotRecorder } from "../shots/recorder.js";
import type { FlowHoldDriver } from "../xenia/flow-hold-driver.js";
import type {
  ApiResponse,
  DriveStartRequest,
  DriveStartResult,
  LiveFrame,
} from "../../../shared/src/types.js";
import { checkMachineReadyToStart } from "../lib/start-gate.js";
import { driveStartBody } from "../lib/body-schemas.js";

export function registerDriveRoutes(
  app: FastifyInstance,
  driver: FlowHoldDriver,
  recorder: ShotRecorder,
  profileRepo: ProfileRepo,
  settingsRepo: SettingsRepo,
  getLastFrame: () => LiveFrame | null,
  getGateFrame: () => Promise<LiveFrame | null>,
): void {
  // ---------------------------------------------------------------------------
  // POST /api/drive/consistent-flow/start
  // ---------------------------------------------------------------------------
  app.post("/api/drive/consistent-flow/start", { schema: { body: driveStartBody } }, async (req, reply) => {
    // Guard: never start on top of an active shot, a running drive, or a
    // suppressed maintenance run.
    if (
      driver.isActive() ||
      recorder.isMaintenanceActive ||
      (recorder.activeShotId !== null &&
        (getLastFrame()?.machineStatus === 3 || getLastFrame()?.machineStatus === 5))
    ) {
      reply.status(409);
      const res: ApiResponse = {
        ok: false,
        error: "Es läuft bereits ein Bezug. Bitte zuerst beenden.",
      };
      return res;
    }

    // H-1: the machine state decides, and it decides fail-closed — the recorder
    // guard above cannot see a brew that this process never started.
    const gate = checkMachineReadyToStart(await getGateFrame());
    if (!gate.ok) {
      reply.status(409);
      const res: ApiResponse = { ok: false, error: gate.error };
      return res;
    }

    const {
      profileId,
      shotSize,
      yieldTargetOverrideG,
      beanId,
      beanLabel,
      grinderId,
      grindSetting,
      grinderRpm,
      doseG,
      notes,
      overrides,
    } = req.body as DriveStartRequest;

    const profile = profileRepo.findById(profileId);
    if (!profile) {
      reply.status(404);
      const res: ApiResponse = { ok: false, error: `Profile ${profileId} not found` };
      return res;
    }

    // Cut-2: a drive is fully app-driven (paddle step sequence), it never runs a
    // machine script. The script_id is recorded only for provenance and may be
    // null for step-based profiles — no script configured is no longer an error.
    const scriptId =
      (shotSize === "single" ? profile.scriptIdSingle : profile.scriptIdDouble) ?? null;

    const profileYield =
      shotSize === "single" ? profile.yieldTargetSingleG : profile.yieldTargetDoubleG;
    const overrideValid =
      typeof yieldTargetOverrideG === "number" &&
      Number.isFinite(yieldTargetOverrideG) &&
      yieldTargetOverrideG > 0;
    const yieldTarget = overrideValid ? yieldTargetOverrideG : profileYield;
    if (yieldTarget === null || yieldTarget === undefined || yieldTarget <= 0) {
      reply.status(400);
      const res: ApiResponse = {
        ok: false,
        error: "Ein gültiges Zielgewicht (yield target) ist für den Flow-Hold-Bezug erforderlich.",
      };
      return res;
    }

    // Merge the profile's step sequence (BrewProfile) into the overrides. Only
    // defined keys are copied so an explicit request override always wins and we
    // never clobber a driver default with `undefined`.
    let mergedOverrides = overrides;
    // 2× reuses the 1× sequence unless the profile carries a dedicated one.
    const bp =
      shotSize === "double"
        ? (profile.brewStepsDouble ?? profile.brewSteps)
        : profile.brewSteps;
    if (bp) {
      const fromProfile: Record<string, unknown> = {};
      if (bp.steps !== undefined) fromProfile.steps = bp.steps;
      mergedOverrides = { ...fromProfile, ...(overrides ?? {}) };
    }

    try {
      const cfg = await driver.start(
        mergedOverrides,
        yieldTarget,
        {
          profileId,
          profileName: profile.name ?? null,
          scriptId,
          shotSize,
          beanId: beanId ?? null,
          beanLabel: beanLabel ?? null,
          grinderId: grinderId ?? null,
          grindSetting: grindSetting ?? null,
          grinderRpm: grinderRpm ?? null,
          doseG: doseG ?? null,
          notes: notes ?? null,
        },
        getLastFrame(),
      );

      // Persist active bean/grinder for the next pre-shot dialog (parity with execute).
      if (beanId !== undefined && beanId !== null) {
        settingsRepo.set("active_bean_id", String(beanId));
      }
      if (grinderId !== undefined && grinderId !== null) {
        settingsRepo.set("active_grinder_id", String(grinderId));
      }

      const res: DriveStartResult = {
        ok: true,
        scriptId,
        yieldTargetG: cfg.yieldTargetG,
        targetFlowGs: cfg.targetFlowGs,
      };
      return res;
    } catch (err) {
      reply.status(502);
      const res: ApiResponse = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      return res;
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/drive/consistent-flow/stop — abort a running drive
  // ---------------------------------------------------------------------------
  app.post("/api/drive/consistent-flow/stop", async (_req, reply) => {
    if (!driver.isActive()) {
      reply.status(409);
      const res: ApiResponse = { ok: false, error: "Kein Flow-Hold-Bezug aktiv." };
      return res;
    }
    driver.requestStop();
    const res: ApiResponse = { ok: true };
    return res;
  });
}
