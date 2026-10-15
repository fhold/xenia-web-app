/**
 * useRecentShots — loads the most recent brew shots for the dashboard.
 *
 * Re-fetches whenever `reloadKey` changes. The dashboard passes the id of the
 * last ended shot, so the list refreshes right after every brew finishes.
 */

import { useCallback, useEffect, useState } from "react";
import type { RecentShot } from "@shared/types.js";

export function useRecentShots(reloadKey: number): {
  shots: RecentShot[];
  loading: boolean;
  refetch: () => void;
} {
  const [shots, setShots] = useState<RecentShot[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch("/api/shots/recent?limit=5", { signal: controller.signal })
      .then((r) => r.json() as Promise<RecentShot[]>)
      .then((data) => {
        setShots(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        // AbortError just means the effect re-ran — not a real error.
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoading(false);
      });
    return () => { controller.abort(); };
  }, [reloadKey, tick]);

  const refetch = useCallback(() => { setTick((n) => n + 1); }, []);

  return { shots, loading, refetch };
}
