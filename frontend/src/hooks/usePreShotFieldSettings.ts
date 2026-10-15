/**
 * usePreShotFieldSettings — fetches the pre-shot dialog field visibility
 * flags from the backend. Returns hard-coded defaults until the fetch
 * resolves, or on error.
 *
 * Mirrors the useBeanFieldSettings pattern.
 */

import { useCallback, useEffect, useState } from "react";

export interface PreShotFieldSettings {
  /** Show the grinder dropdown. */
  grinder: boolean;
  /** Show the grind setting input. */
  grindSetting: boolean;
  /** Show the RPM input (additionally gated by grinder.supportsRpm). */
  grinderRpm: boolean;
  /** Show the dose input. */
  dose: boolean;
  /** Show the read-only profile-note panel beside the fields. */
  profileNotes: boolean;
}

const DEFAULTS: PreShotFieldSettings = {
  grinder:      true,
  grindSetting: true,
  grinderRpm:   true,
  dose:         true,
  profileNotes: true,
};

export function usePreShotFieldSettings(): {
  settings: PreShotFieldSettings;
  refetch: () => void;
} {
  const [settings, setSettings] = useState<PreShotFieldSettings>(DEFAULTS);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    fetch("/api/settings/preshot-fields")
      .then((r) => r.json() as Promise<PreShotFieldSettings>)
      .then(setSettings)
      .catch(() => {
        // Keep defaults — the dialog still works with all fields visible
      });
  }, [tick]);

  const refetch = useCallback(() => { setTick((n) => n + 1); }, []);

  return { settings, refetch };
}
