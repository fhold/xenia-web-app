/**
 * Persistence + startup reconciliation for the PT-2 profile-temp reset (M-5).
 *
 * The armed state used to live only in RAM. A restart then left the machine
 * standing at a profile temp with nothing left that knew what it stood at
 * before. The record goes into the existing key/value `settings` table — no
 * schema change — and is checked against the machine on the way back up.
 */

import type {
  ProfileTempPrevSetpoints,
  ProfileTempResetPersistence,
} from "../../../shared/src/profile-temp-reset.js";
import type { SettingsRepo } from "../db/settings-repo.js";
import type { SetpointsFrame } from "../../../shared/src/types.js";

export const PROFILE_TEMP_RESET_KEY = "profile_temp_reset_prev";

export function makeProfileTempResetPersistence(
  settings: SettingsRepo,
): ProfileTempResetPersistence {
  return {
    save(prev) {
      if (prev === null) settings.delete(PROFILE_TEMP_RESET_KEY);
      else settings.set(PROFILE_TEMP_RESET_KEY, JSON.stringify(prev));
    },
  };
}

/** A record written by an older version, hand-edited, or truncated. */
function parse(raw: string | undefined): ProfileTempPrevSetpoints | null {
  if (raw === undefined) return null;
  try {
    const v = JSON.parse(raw) as Partial<ProfileTempPrevSetpoints>;
    if (typeof v?.bgC !== "number" || !Number.isFinite(v.bgC)) return null;
    if (typeof v?.bbC !== "number" || !Number.isFinite(v.bbC)) return null;
    return { bgC: v.bgC, bbC: v.bbC };
  } catch {
    return null;
  }
}

export type ReconcileOutcome =
  | { action: "none" }
  | { action: "rearm"; prev: ProfileTempPrevSetpoints }
  | { action: "drop"; reason: "already-restored" | "unreadable" }
  | { action: "keep"; reason: "machine-unreachable" };

/**
 * Decide what a stored record means given the machine's current setpoints.
 *
 * Re-arm only while restoring would still change something. Once the machine
 * already stands at the remembered pair — because the reset ran before the
 * restart, or because the user dialled it back by hand — the record is spent,
 * and offering to "restore" the values already running is the exact prompt
 * `from-profile` goes out of its way not to arm.
 *
 * Without a fresh frame nothing is decided: dropping the record on an
 * unreachable machine would throw away the only copy of the old setpoints.
 */
export function reconcileProfileTempReset(
  raw: string | undefined,
  setpoints: SetpointsFrame | null,
): ReconcileOutcome {
  if (raw === undefined) return { action: "none" };
  const prev = parse(raw);
  if (prev === null) return { action: "drop", reason: "unreadable" };
  if (setpoints === null) return { action: "keep", reason: "machine-unreachable" };
  const restored =
    setpoints.brewGroupTargetC.toFixed(1) === prev.bgC.toFixed(1) &&
    setpoints.brewBoilerTargetC.toFixed(1) === prev.bbC.toFixed(1);
  return restored ? { action: "drop", reason: "already-restored" } : { action: "rearm", prev };
}
