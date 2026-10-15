import type { FastifyInstance } from "fastify";
import type { SettingsRepo } from "../db/settings-repo.js";
import type { MaintenanceLogRepo } from "../db/maintenance-repo.js";
import type { ApiResponse } from "../../../shared/src/types.js";

const DAY_MS = 86_400_000;
const SNOOZE_MS = 2 * DAY_MS; // "Später" hides the banner for 2 days

function parseIntSetting(v: string | undefined, fallback: number): number {
  const n = v !== undefined && v !== "" ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function parseScriptIds(v: string | undefined): number[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n));
}

/**
 * Backflush reminder — surfaces a "please backflush" banner when the last run of
 * a designated maintenance script is older than the configured threshold.
 *
 * "Last flushed" = max(baseline, newest maintenance_log run of a selected
 * script). The baseline is seeded to install time and bumped by the manual
 * "Erledigt" reset (covers a flush done directly at the machine). "Später"
 * snoozes the banner. All config lives in settings (PUT /api/settings).
 */
export function registerMaintenanceRoutes(
  app: FastifyInstance,
  settingsRepo: SettingsRepo,
  maintenanceLog: MaintenanceLogRepo,
): void {
  app.get("/api/maintenance/backflush", async () => {
    const enabled = (settingsRepo.get("backflush_reminder_enabled") ?? "true") === "true";
    const thresholdDays = parseIntSetting(settingsRepo.get("backflush_reminder_days"), 14);
    const scriptIds = parseScriptIds(settingsRepo.get("backflush_script_ids"));
    const baselineAt = parseIntSetting(settingsRepo.get("backflush_baseline_at"), 0);
    const snoozeUntil = parseIntSetting(settingsRepo.get("backflush_snooze_until"), 0);

    const lastRun = maintenanceLog.lastRanAt(scriptIds);
    const lastAt = Math.max(baselineAt, lastRun ?? 0);
    const now = Date.now();
    const daysAgo = lastAt > 0 ? Math.floor((now - lastAt) / DAY_MS) : null;
    const due =
      enabled &&
      scriptIds.length > 0 &&
      now > snoozeUntil &&
      lastAt > 0 &&
      now - lastAt > thresholdDays * DAY_MS;

    return { enabled, lastAt, daysAgo, due, thresholdDays, scriptIds, snoozeUntil };
  });

  // "Erledigt" — mark backflush as done now (also covers a flush done directly
  // at the machine, which the app can't auto-detect).
  app.post("/api/maintenance/backflush/done", async () => {
    settingsRepo.set("backflush_baseline_at", String(Date.now()));
    return { ok: true } as ApiResponse;
  });

  // "Später" — snooze the banner for SNOOZE_MS.
  app.post("/api/maintenance/backflush/snooze", async () => {
    settingsRepo.set("backflush_snooze_until", String(Date.now() + SNOOZE_MS));
    return { ok: true } as ApiResponse;
  });
}
