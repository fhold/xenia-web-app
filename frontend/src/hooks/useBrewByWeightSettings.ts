/**
 * useBrewByWeightSettings — fetches brew-by-weight settings from the backend.
 * Returns hard-coded defaults until the fetch resolves (or on error).
 *
 * Returns { settings, refetch } so callers can invalidate after a PUT.
 */

import { useCallback, useEffect, useState } from "react";

export interface BrewByWeightSettings {
  /** Automatic stop active when yield target is set in profile. */
  active: boolean;
  /** Moving-window width for weight detection in milliseconds. */
  windowMs: number;
  /** Residual lag compensation in seconds. */
  residualLagS: number;
  /** Auto-calibration of residualLagS after each app-stopped brew (Spec §4.12). */
  autoCalibrate: boolean;
}

const DEFAULTS: BrewByWeightSettings = {
  active:        false,
  windowMs:      1000,
  residualLagS:  1.35,
  autoCalibrate: true,
};

export function useBrewByWeightSettings(): {
  settings: BrewByWeightSettings;
  refetch: () => void;
} {
  const [settings, setSettings] = useState<BrewByWeightSettings>(DEFAULTS);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    fetch("/api/settings/brew-by-weight")
      .then((r) => r.json() as Promise<BrewByWeightSettings>)
      .then(setSettings)
      .catch(() => {
        // Keep defaults
      });
  }, [tick]);

  const refetch = useCallback(() => { setTick((n) => n + 1); }, []);

  return { settings, refetch };
}
