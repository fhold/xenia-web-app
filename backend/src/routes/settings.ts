/**
 * Settings routes — chart and general configuration.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SqliteSettingsRepo } from "../db/settings-repo.js";

// ---------------------------------------------------------------------------
// Whitelist — which keys may be mutated via PUT /api/settings/:key
// ---------------------------------------------------------------------------

type SettingType = "boolean" | "number" | "enum" | "string";

interface SettingDef {
  type: SettingType;
  /** Integer min bound — for type "number" only. */
  min?: number;
  /** Integer/float max bound — for type "number" only. */
  max?: number;
  /** Whether the value is a float (default: integer). */
  float?: boolean;
  /** Allowed string values — for type "enum" only. */
  values?: string[];
  /** Format constraint — for type "string" only. */
  pattern?: RegExp;
}

const ALLOWED: Record<string, SettingDef> = {
  chart_x_window_s:              { type: "number",  min: 5,   max: 600  },
  chart_x_slide_step_s:          { type: "number",  min: 1,   max: 60   },
  chart_x_grow:                  { type: "boolean" },
  chart_x_resize_on_end:         { type: "boolean" },
  chart_x_resize_animation:      { type: "boolean" },
  show_script_overlay:           { type: "boolean" },
  show_pump_curve:               { type: "boolean" },
  show_stage_markers:            { type: "boolean" },
  show_ghosts:                   { type: "boolean" },
  ghost_count:                   { type: "number",  min: 1,   max: 50   },
  brew_by_weight_active:         { type: "boolean" },
  brew_by_weight_window_ms:      { type: "number",  min: 100, max: 10000 },
  brew_by_weight_residual_lag_s: { type: "number",  min: 0,   max: 10, float: true },
  brew_by_weight_auto_calibrate: { type: "boolean" },
  brew_by_weight_watchdog_enabled:     { type: "boolean" },
  brew_by_weight_watchdog_stop_lag_ms: { type: "number",  min: 500, max: 30000 },
  brew_by_weight_watchdog_overshoot_g: { type: "number",  min: 1,   max: 50, float: true },
  post_brew_max_duration_ms:     { type: "number",  min: 0,    max: 30000 },
  post_brew_stable_delta_g:      { type: "number",  min: 0.01, max: 5, float: true },
  post_brew_stable_window_ms:    { type: "number",  min: 100,  max: 5000 },
  language:                      { type: "enum",    values: ["de", "en"] },
  show_tds_input:                { type: "boolean" },
  rating_compare_prev:           { type: "boolean" },
  bean_fields_origin:            { type: "boolean" },
  bean_fields_inventory:         { type: "boolean" },
  bean_fields_aroma:             { type: "boolean" },
  bean_fields_freeze_dates:      { type: "boolean" },
  preshot_field_grinder:         { type: "boolean" },
  preshot_field_grind_setting:   { type: "boolean" },
  preshot_field_grinder_rpm:     { type: "boolean" },
  preshot_field_dose:            { type: "boolean" },
  preshot_field_profile_notes:   { type: "boolean" },
  // Rückspül-Reminder
  backflush_reminder_enabled:    { type: "boolean" },
  backflush_reminder_days:       { type: "number",  min: 1, max: 365 },
  backflush_profile_ids:         { type: "string",  pattern: /^(\d+(,\d+)*)?$/ }, // "" or "2,7"
};

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

type ValidationResult =
  | { ok: true; normalized: string }
  | { ok: false; error: string };

function validate(key: string, rawValue: string): ValidationResult {
  const def = ALLOWED[key];
  if (!def) return { ok: false, error: `Unknown or read-only setting: ${key}` };

  if (def.type === "boolean") {
    if (rawValue !== "true" && rawValue !== "false") {
      return { ok: false, error: `${key} must be "true" or "false"` };
    }
    return { ok: true, normalized: rawValue };
  }

  if (def.type === "enum") {
    if (!def.values!.includes(rawValue)) {
      return { ok: false, error: `${key} must be one of: ${def.values!.join(", ")}` };
    }
    return { ok: true, normalized: rawValue };
  }

  if (def.type === "string") {
    if (def.pattern && !def.pattern.test(rawValue)) {
      return { ok: false, error: `${key} has an invalid format` };
    }
    return { ok: true, normalized: rawValue };
  }

  // type === "number"
  const num = def.float ? parseFloat(rawValue) : parseInt(rawValue, 10);
  if (isNaN(num)) return { ok: false, error: `${key} must be a number` };
  if (def.min !== undefined && num < def.min) {
    return { ok: false, error: `${key} must be >= ${def.min}` };
  }
  if (def.max !== undefined && num > def.max) {
    return { ok: false, error: `${key} must be <= ${def.max}` };
  }
  return { ok: true, normalized: String(num) };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerSettingsRoutes(
  app: FastifyInstance,
  settingsRepo: SqliteSettingsRepo,
): void {
  /**
   * GET /api/settings/chart
   *
   * Returns the four chart_x_* settings as a typed object.
   * Frontend uses this to configure the ShotChart x-axis behaviour.
   */
  app.get("/api/settings/chart", async () => {
    return {
      window:          parseInt(settingsRepo.get("chart_x_window_s")        ?? "30",  10),
      slideStep:       parseInt(settingsRepo.get("chart_x_slide_step_s")    ?? "10",  10),
      grow:           (settingsRepo.get("chart_x_grow")                     ?? "true") === "true",
      resizeOnEnd:    (settingsRepo.get("chart_x_resize_on_end")            ?? "true") === "true",
      resizeAnimation:(settingsRepo.get("chart_x_resize_animation")         ?? "true") === "true",
      showScriptOverlay:(settingsRepo.get("show_script_overlay")            ?? "false") === "true",
      showPumpCurve:    (settingsRepo.get("show_pump_curve")                ?? "false") === "true",
      showStageMarkers: (settingsRepo.get("show_stage_markers")             ?? "false") === "true",
      showGhosts:       (settingsRepo.get("show_ghosts")                    ?? "false") === "true",
      ghostCount:       parseInt(settingsRepo.get("ghost_count")            ?? "20",  10),
    };
  });

  /**
   * GET /api/settings/brew-by-weight
   *
   * Returns brew-by-weight settings as a typed object.
   * Used by useBrewByWeightSettings hook.
   */
  app.get("/api/settings/brew-by-weight", async () => {
    return {
      active:        (settingsRepo.get("brew_by_weight_active")          ?? "false") === "true",
      windowMs:       parseInt(settingsRepo.get("brew_by_weight_window_ms")      ?? "1000", 10),
      residualLagS:   parseFloat(settingsRepo.get("brew_by_weight_residual_lag_s") ?? "1.35"),
      autoCalibrate: (settingsRepo.get("brew_by_weight_auto_calibrate") ?? "true") === "true",
      watchdogEnabled:  (settingsRepo.get("brew_by_weight_watchdog_enabled")     ?? "true") === "true",
      watchdogStopLagMs: parseInt(settingsRepo.get("brew_by_weight_watchdog_stop_lag_ms") ?? "3000", 10),
      watchdogOvershootG: parseFloat(settingsRepo.get("brew_by_weight_watchdog_overshoot_g") ?? "7"),
    };
  });

  /**
   * GET /api/settings/bean-fields
   *
   * Returns the bean editor section visibility flags as a typed object.
   * Used by the useBeanFieldSettings hook.
   */
  app.get("/api/settings/bean-fields", async () => {
    return {
      origin:      (settingsRepo.get("bean_fields_origin")       ?? "true") === "true",
      inventory:   (settingsRepo.get("bean_fields_inventory")    ?? "true") === "true",
      aroma:       (settingsRepo.get("bean_fields_aroma")        ?? "true") === "true",
      freezeDates: (settingsRepo.get("bean_fields_freeze_dates") ?? "true") === "true",
    };
  });

  /**
   * GET /api/settings/preshot-fields
   *
   * Returns the pre-shot dialog field visibility flags as a typed object.
   * Used by the usePreShotFieldSettings hook.
   */
  app.get("/api/settings/preshot-fields", async () => {
    return {
      grinder:      (settingsRepo.get("preshot_field_grinder")       ?? "true")  === "true",
      grindSetting: (settingsRepo.get("preshot_field_grind_setting") ?? "true")  === "true",
      grinderRpm:   (settingsRepo.get("preshot_field_grinder_rpm")   ?? "true")  === "true",
      dose:         (settingsRepo.get("preshot_field_dose")          ?? "true")  === "true",
      profileNotes: (settingsRepo.get("preshot_field_profile_notes") ?? "true")  === "true",
    };
  });

  /**
   * GET /api/settings
   *
   * Returns all settings as a flat key→value map.
   * Used by the Settings view to load initial state.
   */
  app.get("/api/settings", async () => {
    const map = settingsRepo.getAll();
    return Object.fromEntries(map.entries());
  });

  /**
   * PUT /api/settings/:key
   *
   * Updates a single whitelisted setting.
   * Body: { value: string | number }
   */
  app.put(
    "/api/settings/:key",
    async (
      req: FastifyRequest<{ Params: { key: string }; Body: { value: unknown } }>,
      reply: FastifyReply,
    ) => {
      const { key } = req.params;
      const body = req.body as { value?: unknown } | undefined;
      const value = body?.value;

      let rawValue: string;
      if (typeof value === "string") {
        rawValue = value;
      } else if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        ALLOWED[key]?.type === "number"
      ) {
        rawValue = String(value);
      } else {
        return reply.status(400).send({
          error: "Body must include { value: string }, or { value: number } for numeric settings",
        });
      }

      const result = validate(key, rawValue);
      if (!result.ok) {
        return reply.status(400).send({ error: result.error });
      }

      settingsRepo.set(key, result.normalized);
      return { key, value: result.normalized };
    },
  );
}
