/**
 * useShotGhosts — the past shots drawn faintly behind one shot.
 *
 * Fetched per shot and only when the ghosts are actually shown, so opening the
 * history costs nothing extra until you ask for the comparison.
 */

import { useEffect, useState } from "react";

export interface GhostShot {
  id: number;
  /** Pressure (bar) on the common grid; null where that shot had no data. */
  pressure: (number | null)[];
  /** Flow (ml/s) on the common grid. */
  flow: (number | null)[];
}

export interface ShotGhosts {
  /** What the cloud was grouped by — the legend has to say which. */
  basis: "brewdef" | "profile";
  gridMs: number;
  shots: GhostShot[];
}

export function useShotGhosts(
  shotId: number | null,
  enabled: boolean,
  limit: number,
): { ghosts: ShotGhosts | null; loading: boolean } {
  const [ghosts, setGhosts] = useState<ShotGhosts | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (shotId === null || !enabled) {
      setGhosts(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/shots/${shotId}/ghosts?limit=${limit}`)
      .then((r) => (r.ok ? (r.json() as Promise<ShotGhosts>) : null))
      .then((data) => {
        if (!cancelled) setGhosts(data);
      })
      .catch(() => {
        if (!cancelled) setGhosts(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [shotId, enabled, limit]);

  return { ghosts, loading };
}
