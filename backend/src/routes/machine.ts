/**
 * Machine control routes — Phase 1 Step 3.
 *
 * All routes return ApiResponse: { ok: true } or { ok: false, error: "..." }.
 * POST responses from the Xenia carry no meaningful status (Handoff 2.5) —
 * state changes are verified implicitly via the next poll frame.
 */

import type { FastifyInstance } from "fastify";
import { XeniaClient, XeniaError } from "../xenia/client.js";
import { SqliteSettingsRepo } from "../db/settings-repo.js";
import type { XeniaPoller } from "../xenia/poller.js";
import type { LiveFrame } from "../../../shared/src/types.js";
import type {
  ApiResponse,
  PowerRequest,
  SteamRequest,
  EcoRequest,
  SetpointsUpdateRequest,
  SetFromProfileRequest,
  ResetProfileTempRequest,
  ScaleStatus,
} from "../../../shared/src/types.js";
import {
  parseTargetTempC,
  TARGET_TEMP_MIN_C,
  TARGET_TEMP_MAX_C,
} from "../../../shared/src/profile-temp.js";
import type { ProfileTempResetStore } from "../../../shared/src/profile-temp-reset.js";

// ---------------------------------------------------------------------------
// Body schemas (H-4)
//
// A TypeScript cast validates nothing at runtime. Without a schema `{"on":"false"}`
// is a truthy string and switched the machine ON, and a setpoint of 1e999 became
// Infinity → "Infinity" was sent to the machine as a temperature. Fastify's AJV
// coerces "true"/"false" to booleans and rejects anything else with a 400.
// ---------------------------------------------------------------------------

/** `{ on: boolean }` — power, steam and eco all take exactly this. */
const onBody = {
  type: "object",
  required: ["on"],
  properties: { on: { type: "boolean" } },
  additionalProperties: false,
} as const;

/** A setpoint the machine will accept — finite and inside the physical range. */
const tempC = {
  type: "number",
  minimum: TARGET_TEMP_MIN_C,
  maximum: TARGET_TEMP_MAX_C,
} as const;

const setpointsBody = {
  type: "object",
  properties: { brewGroupTargetC: tempC, brewBoilerTargetC: tempC },
  additionalProperties: false,
} as const;

const applyBody = {
  type: "object",
  required: ["apply"],
  properties: { apply: { type: "boolean" } },
  additionalProperties: false,
} as const;

/**
 * Resolve which "turn on" action to send based on the last known steam boiler status.
 *
 * Used for both power-on and eco-off (both transition the machine into ON state):
 *   SB_STATUS = 2 (steam on)  → action "1" (on with steam)
 *   SB_STATUS = 1 (steam off) → action "5" (on without steam)
 *   No frame yet              → action "1" (conservative default)
 *
 * This preserves the user's last steam preference across power/eco cycles
 * without requiring the frontend to track SB state.
 */
function resolveOnAction(frame: LiveFrame | null): string {
  if (frame === null) return "1";
  return frame.steamBoilerStatus === 2 ? "1" : "5";
}

export function registerMachineRoutes(
  app: FastifyInstance,
  client: XeniaClient,
  getLastFrame: () => LiveFrame | null,
  poller: XeniaPoller,
  resetStore: ProfileTempResetStore,
): void {
  // ---------------------------------------------------------------------------
  // GET /api/scale — one-off BT scale connection check (pre-brew warning).
  // Connected ⇔ `connected_device` present, or DEVICE_NAME array non-empty.
  // ---------------------------------------------------------------------------
  app.get("/api/scale", async (_req, reply) => {
    try {
      const raw = await client.scale();
      const deviceName =
        typeof raw.connected_device === "string" && raw.connected_device.length > 0
          ? raw.connected_device
          : Array.isArray(raw.DEVICE_NAME) && raw.DEVICE_NAME.length > 0 && raw.DEVICE_NAME[0]
            ? raw.DEVICE_NAME[0]
            : null;
      const res: ScaleStatus = { ok: true, connected: deviceName !== null, deviceName };
      return res;
    } catch (err) {
      reply.status(502);
      const res: ApiResponse = { ok: false, error: errMsg(err) };
      return res;
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/machine/power
  // ---------------------------------------------------------------------------
  app.post("/api/machine/power", { schema: { body: onBody } }, async (req, reply) => {
    const { on } = req.body as PowerRequest;
    try {
      await client.machineControl(on ? resolveOnAction(getLastFrame()) : "0");
      const res: ApiResponse = { ok: true };
      return res;
    } catch (err) {
      reply.status(502);
      const res: ApiResponse = { ok: false, error: errMsg(err) };
      return res;
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/machine/steam
  // ---------------------------------------------------------------------------
  app.post("/api/machine/steam", { schema: { body: onBody } }, async (req, reply) => {
    const { on } = req.body as SteamRequest;
    try {
      await client.toggleSteamBoiler(on);
      const res: ApiResponse = { ok: true };
      return res;
    } catch (err) {
      reply.status(502);
      const res: ApiResponse = { ok: false, error: errMsg(err) };
      return res;
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/machine/eco
  // ---------------------------------------------------------------------------
  // ECO on  → action "2"
  // ECO off → resolveOnAction() preserves SB status (action "1" or "5")
  //           Note: action "5" from ECO is untested on live HW — observe first.
  app.post("/api/machine/eco", { schema: { body: onBody } }, async (req, reply) => {
    const { on } = req.body as EcoRequest;
    try {
      await client.machineControl(on ? "2" : resolveOnAction(getLastFrame()));
      const res: ApiResponse = { ok: true };
      return res;
    } catch (err) {
      reply.status(502);
      const res: ApiResponse = { ok: false, error: errMsg(err) };
      return res;
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/machine/setpoints
  // ---------------------------------------------------------------------------
  // Calls /inc_dec with string values (Xenia API quirk — Handoff 2.1).
  // Steam boiler pressure setpoint deliberately omitted: /inc_dec only
  // documents BG_SET_TEMP and BB_SET_TEMP (Handoff 2.1).
  app.post("/api/machine/setpoints", { schema: { body: setpointsBody } }, async (req, reply) => {
    const body = req.body as SetpointsUpdateRequest;
    try {
      const params: { BG_SET_TEMP?: string; BB_SET_TEMP?: string } = {};
      if (body.brewGroupTargetC !== undefined) {
        params.BG_SET_TEMP = body.brewGroupTargetC.toFixed(1);
      }
      if (body.brewBoilerTargetC !== undefined) {
        params.BB_SET_TEMP = body.brewBoilerTargetC.toFixed(1);
      }
      // Brühgruppe→Brühboiler 1:1-Kopplung (einseitig): ändert sich die
      // Brühgruppe, zieht der Brühboiler-Sollwert 1:1 nach. Live aus der DB
      // gelesen, damit das versteckte Setting ohne Restart greift.
      if (
        body.brewGroupTargetC !== undefined &&
        new SqliteSettingsRepo().get("brew_group_boiler_coupling") === "true"
      ) {
        params.BB_SET_TEMP = body.brewGroupTargetC.toFixed(1);
      }
      if (Object.keys(params).length > 0) {
        await client.setTemperatures(params);
        // Refetch setpoints immediately so the UI's SOLL value updates now
        // instead of waiting up to 60s for the next periodic poll.
        // /inc_dec verified on FW 4.25: absolute set, handles BG + BB.
        await poller.refreshSetpoints();
      }
      const res: ApiResponse = { ok: true };
      return res;
    } catch (err) {
      reply.status(502);
      const res: ApiResponse = { ok: false, error: errMsg(err) };
      return res;
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/machine/setpoints/from-profile  (PT-2)
  // ---------------------------------------------------------------------------
  // Sets BOTH the brew-group AND the brew-boiler setpoint to a profile's target
  // temp on explicit user tap — the profile temp is THE brew temperature and
  // applies to both boilers. Arms a one-shot post-brew reset to the BG + BB
  // setpoints that were active before (Fork 5 / M3).
  app.post("/api/machine/setpoints/from-profile", async (req, reply) => {
    const body = req.body as SetFromProfileRequest;
    const parse = parseTargetTempC(body.targetTempC);
    if (!parse.ok || parse.value === null) {
      reply.status(400);
      const res: ApiResponse = {
        ok: false,
        error: parse.ok ? "targetTempC is required" : parse.error,
      };
      return res;
    }
    try {
      // Capture the pre-set setpoints BEFORE changing them, so a failed set never
      // arms a reset. arm() is a no-op when already armed (M3 — keep the first
      // remembered pair across two profile sets in a row).
      const current = poller.getLastSetpoints();
      const target = parse.value.toFixed(1);
      await client.setTemperatures({ BG_SET_TEMP: target, BB_SET_TEMP: target });
      // Only arm when the set actually moves a setpoint. Arming on a no-op set
      // (profile temp already on the machine) would offer to "restore" the very
      // value that is running, and that prompt then survives until answered.
      if (current !== null) {
        const moves =
          current.brewGroupTargetC.toFixed(1) !== target ||
          current.brewBoilerTargetC.toFixed(1) !== target;
        if (moves) resetStore.arm(current.brewGroupTargetC, current.brewBoilerTargetC);
      }
      // 3p-pull: refetch + WS-push so the gauges + armed state update now.
      await poller.refreshSetpoints();
      const res: ApiResponse = { ok: true };
      return res;
    } catch (err) {
      reply.status(502);
      const res: ApiResponse = { ok: false, error: errMsg(err) };
      return res;
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/machine/setpoints/reset-profile-temp  (PT-2)
  // ---------------------------------------------------------------------------
  // Post-shot prompt outcome. apply=true → restore the remembered previous BG
  // AND BB setpoints, then clear. apply=false → just dismiss (clear, no machine
  // interaction). No-op (200) when nothing is armed.
  app.post(
    "/api/machine/setpoints/reset-profile-temp",
    { schema: { body: applyBody } },
    async (req, reply) => {
      const body = req.body as ResetProfileTempRequest;
      const previous = resetStore.previous();
      if (previous === null) {
        const res: ApiResponse = { ok: true }; // nothing armed → no-op
        return res;
      }
      try {
        if (body.apply) {
          await client.setTemperatures({
            BG_SET_TEMP: previous.bgC.toFixed(1),
            BB_SET_TEMP: previous.bbC.toFixed(1),
          });
        }
        resetStore.clear();
        // Re-broadcast setpoints so clients see the cleared armed state (and, for
        // apply=true, the restored SOLL) without waiting for the next poll.
        await poller.refreshSetpoints();
        const res: ApiResponse = { ok: true };
        return res;
      } catch (err) {
        reply.status(502);
        const res: ApiResponse = { ok: false, error: errMsg(err) };
        return res;
      }
    },
  );
}

function errMsg(err: unknown): string {
  return err instanceof XeniaError ? err.message : String(err);
}
