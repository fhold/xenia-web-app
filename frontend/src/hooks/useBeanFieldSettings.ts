/**
 * useBeanFieldSettings — fetches the bean editor section visibility flags
 * from the backend. Returns hard-coded defaults (all visible) until the
 * fetch resolves, or on error.
 *
 * Returns { settings, refetch } so callers can invalidate after a PUT.
 * Mirrors the useChartSettings pattern.
 */

import { useCallback, useEffect, useState } from "react";

export interface BeanFieldSettings {
  /** Show the Herkunft section (country, region, farm, variety, …). */
  origin: boolean;
  /** Show the Bestand section (bag size, price, remaining). */
  inventory: boolean;
  /** Show the Aroma & Notizen sections (flavor notes, free-text notes). */
  aroma: boolean;
  /** Show the frozen/thaw date fields when status is frozen/thawed. */
  freezeDates: boolean;
}

const DEFAULTS: BeanFieldSettings = {
  origin:      true,
  inventory:   true,
  aroma:       true,
  freezeDates: true,
};

export function useBeanFieldSettings(): {
  settings: BeanFieldSettings;
  refetch: () => void;
} {
  const [settings, setSettings] = useState<BeanFieldSettings>(DEFAULTS);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    fetch("/api/settings/bean-fields")
      .then((r) => r.json() as Promise<BeanFieldSettings>)
      .then(setSettings)
      .catch(() => {
        // Keep defaults — the editor still works with all sections visible
      });
  }, [tick]);

  const refetch = useCallback(() => { setTick((n) => n + 1); }, []);

  return { settings, refetch };
}
