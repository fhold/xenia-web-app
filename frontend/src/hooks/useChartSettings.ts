/**
 * useChartSettings — fetches chart_x_* settings from the backend.
 * Returns hard-coded defaults until the fetch resolves (or on error).
 *
 * Returns { settings, refetch } so callers can invalidate after a PUT.
 */

import { useCallback, useEffect, useState } from "react";

export interface ChartXSettings {
  /** Sliding-window width in seconds (chart_x_window_s). Default 30. */
  window: number;
  /** Seconds each slide step advances xMin (chart_x_slide_step_s). Default 10. */
  slideStep: number;
  /** Zeitachse waechst mit dem Bezug statt zu schieben (chart_x_grow). Default true. */
  grow: boolean;
  /** Zoom to full shot duration when shot ends (chart_x_resize_on_end). Default true. */
  resizeOnEnd: boolean;
  /** Animate the end-of-shot resize (chart_x_resize_animation). Default true. */
  resizeAnimation: boolean;
  /** SO-1: opt-in commanded-vs-actual overlay in shot detail. Default false. */
  showScriptOverlay: boolean;
  /** Opt-in measured pump-power (%) curve in shot detail. Default false. */
  showPumpCurve: boolean;
  /** Opt-in Flow-Hold stage markers + Soll staircase in shot detail. Default false. */
  showStageMarkers: boolean;
  /** Opt-in ghost curves of past shots behind the current one. Default false. */
  showGhosts: boolean;
  /** How many past shots the ghost cloud draws. Default 20. */
  ghostCount: number;
}

const DEFAULTS: ChartXSettings = {
  window:          30,
  slideStep:       10,
  grow:            true,
  resizeOnEnd:     true,
  resizeAnimation: true,
  showScriptOverlay: false,
  showPumpCurve:   false,
  showStageMarkers: false,
  showGhosts:      false,
  ghostCount:      20,
};

export function useChartSettings(): { settings: ChartXSettings; refetch: () => void } {
  const [settings, setSettings] = useState<ChartXSettings>(DEFAULTS);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    fetch("/api/settings/chart")
      .then((r) => r.json() as Promise<ChartXSettings>)
      .then(setSettings)
      .catch(() => {
        // Keep defaults — chart still works without the setting
      });
  }, [tick]);

  const refetch = useCallback(() => { setTick((n) => n + 1); }, []);

  return { settings, refetch };
}
