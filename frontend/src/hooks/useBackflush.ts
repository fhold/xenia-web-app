import { useCallback, useEffect, useState } from "react";

/** Backflush reminder status from GET /api/maintenance/backflush. */
export interface BackflushStatus {
  enabled: boolean;
  lastAt: number;
  daysAgo: number | null;
  due: boolean;
  thresholdDays: number;
  scriptIds: number[];
  snoozeUntil: number;
}

export interface UseBackflushReturn {
  status: BackflushStatus | null;
  refetch: () => Promise<void>;
  /** "Erledigt" — mark backflush done now (baseline reset). */
  markDone: () => Promise<void>;
  /** "Später" — snooze the banner. */
  snooze: () => Promise<void>;
}

/**
 * Backflush reminder. Refetches on mount and when the tab regains focus /
 * becomes visible (cheap, not time-critical). Callers refetch() after a manual
 * "Jetzt rückspülen" run once the machine has logged it.
 */
export function useBackflush(): UseBackflushReturn {
  const [status, setStatus] = useState<BackflushStatus | null>(null);

  const refetch = useCallback(async () => {
    try {
      const r = await fetch("/api/maintenance/backflush");
      if (r.ok) setStatus((await r.json()) as BackflushStatus);
    } catch {
      // non-fatal — the banner just won't show
    }
  }, []);

  useEffect(() => {
    void refetch();
    const onActive = () => { void refetch(); };
    window.addEventListener("focus", onActive);
    document.addEventListener("visibilitychange", onActive);
    return () => {
      window.removeEventListener("focus", onActive);
      document.removeEventListener("visibilitychange", onActive);
    };
  }, [refetch]);

  const markDone = useCallback(async () => {
    await fetch("/api/maintenance/backflush/done", { method: "POST" });
    await refetch();
  }, [refetch]);

  const snooze = useCallback(async () => {
    await fetch("/api/maintenance/backflush/snooze", { method: "POST" });
    await refetch();
  }, [refetch]);

  return { status, refetch, markDone, snooze };
}
