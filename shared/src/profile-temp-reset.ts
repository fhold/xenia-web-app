/**
 * Profile-temp pending-reset store (PT-2, Spec §5.8.3a / §5.8.9).
 *
 * Ephemeral, backend-owned, in-memory. When a profile's target brew temp is
 * pushed onto the machine (POST /api/machine/setpoints/from-profile), we
 * remember the BG *and* BB setpoints that were active *before* so the post-shot
 * review can offer to restore them (Fork 4/5). The profile-temp set writes BOTH
 * boilers (brew group + brew boiler) to the target, so the reset restores both.
 *
 * Key invariants (Auftrag decisions):
 * - M3 / Fork 5: the previous setpoints are remembered ONCE per arming cycle — a
 *   second profile-temp set while already armed must NOT overwrite them (so two
 *   profiles in a row still reset to the very first values, not the intermediate).
 * - Persistent via write-through (M-5). This reverses the original decision to
 *   keep it in memory only. "A restart just means no prompt" understated it: the
 *   machine keeps standing at the profile temp while the only record of the
 *   values it stood at before lives in this process. Restarts are not
 *   hypothetical — the delivery pipeline requires one for every backend change.
 *   The store owns the write-through so nothing can arm without persisting;
 *   reconciling the record against the machine at startup is the backend's job.
 * - Only the profile-driven set arms this; the manual SetpointModal path never
 *   touches the store (enforced at the call sites, not here).
 */

/** The BG + BB setpoints (°C) that were active before a profile-temp set. */
export interface ProfileTempPrevSetpoints {
  /** Brew-group setpoint (°C) before the set. */
  bgC: number;
  /** Brew-boiler setpoint (°C) before the set. */
  bbC: number;
}

/** Write-through target that lets an armed reset outlive the process. */
export interface ProfileTempResetPersistence {
  /** Store the armed pair, or drop the record when `prev` is null. */
  save(prev: ProfileTempPrevSetpoints | null): void;
}

export class ProfileTempResetStore {
  private prev: ProfileTempPrevSetpoints | null = null;

  constructor(private readonly persistence?: ProfileTempResetPersistence) {}

  /**
   * Arm the reset by remembering the pre-set BG + BB setpoints. No-op if already
   * armed (M3 — never overwrite the first remembered values).
   */
  arm(bgC: number, bbC: number): void {
    if (this.prev === null) {
      this.prev = { bgC, bbC };
      this.persistence?.save(this.prev);
    }
  }

  /**
   * Adopt a record recovered at startup. No write-through — it is already
   * stored, and the caller has just checked it against the machine.
   */
  restore(prev: ProfileTempPrevSetpoints): void {
    this.prev = prev;
  }

  /** True while a reset is armed. */
  isArmed(): boolean {
    return this.prev !== null;
  }

  /** The remembered previous BG + BB setpoints, or null when not armed. */
  previous(): ProfileTempPrevSetpoints | null {
    return this.prev;
  }

  /** Clear the armed state (after a reset is applied or dismissed). */
  clear(): void {
    this.prev = null;
    this.persistence?.save(null);
  }
}
