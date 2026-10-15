/**
 * usePreShotData — loads the static data the pre-shot dialog needs:
 * the bean list, the grinder list, and the active bean/grinder ids
 * (for prefilling the dropdowns).
 *
 * The reactive "preshot-defaults" prefill (grind/RPM/dose) is NOT here —
 * it depends on the live bean/grinder selection and is fetched inside the
 * dialog component itself.
 */

import { useEffect, useState } from "react";
import type { Bean, Grinder } from "@shared/types.js";

export interface PreShotData {
  beans: Bean[];
  grinders: Grinder[];
  /** active_bean_id from settings, or null if unset / "null". */
  activeBeanId: number | null;
  /** active_grinder_id from settings, or null if unset / "null". */
  activeGrinderId: number | null;
  loading: boolean;
}

/** Parses a settings value that holds an id or the literal string "null". */
function parseIdSetting(value: string | undefined): number | null {
  if (!value || value === "null") return null;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

export function usePreShotData(): PreShotData {
  const [beans, setBeans] = useState<Bean[]>([]);
  const [grinders, setGrinders] = useState<Grinder[]>([]);
  const [activeBeanId, setActiveBeanId] = useState<number | null>(null);
  const [activeGrinderId, setActiveGrinderId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const opts = { signal: controller.signal };

    Promise.all([
      fetch("/api/beans", opts).then((r) => r.json() as Promise<Bean[]>),
      fetch("/api/grinders", opts).then((r) => r.json() as Promise<Grinder[]>),
      fetch("/api/settings", opts).then(
        (r) => r.json() as Promise<Record<string, string>>,
      ),
    ])
      .then(([beanList, grinderList, settings]) => {
        setBeans(beanList);
        setGrinders(grinderList);
        setActiveBeanId(parseIdSetting(settings["active_bean_id"]));
        setActiveGrinderId(parseIdSetting(settings["active_grinder_id"]));
        setLoading(false);
      })
      .catch((err: unknown) => {
        // AbortError means the component unmounted — not a real error.
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoading(false);
      });

    return () => { controller.abort(); };
  }, []);

  return { beans, grinders, activeBeanId, activeGrinderId, loading };
}
