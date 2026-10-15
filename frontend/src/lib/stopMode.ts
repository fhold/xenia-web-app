/**
 * Central readable label for a shot's stop_mode (F-H1) — used by the History
 * card and the detail modal so the two never drift. Cmd27 (machine weight stop),
 * app-BBW, and the safety 'watchdog' (§4.12 / 3m) stay distinct. Labels live in
 * i18n (`history.stopMode.*`).
 */

import type { StopMode } from "@shared/types.js";

type TFn = (key: string) => string;

export function stopModeLabel(t: TFn, mode: StopMode | null): string {
  if (!mode) return "—";
  return t(`history.stopMode.${mode}`);
}

/**
 * stop_modes that represent a problem and should be surfaced with a warning
 * colour: 'app_failed' (the BBW stop was never accepted by the machine) and
 * 'watchdog' (the safety watchdog had to re-fire the stop). The two are still
 * shown with distinct badges/labels — this only governs the value colour.
 */
export function isWarningStopMode(mode: StopMode | null): boolean {
  return mode === "app_failed" || mode === "watchdog";
}
