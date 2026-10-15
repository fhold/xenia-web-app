import { useEffect, useState } from "react";

export type Breakpoint = "mobile" | "tablet" | "desktop";

/**
 * Breakpoint classification.
 *
 * Mobile vs. tablet is decided by the *shorter* screen side, not by width.
 * A width-only threshold cannot tell an iPhone in landscape (844×390) apart
 * from an iPad in portrait (768×1024) — the iPad is the narrower of the two.
 * The shorter side, however, separates them cleanly: phones never exceed
 * ~440px on their short side, iPads sit at 768px.
 *
 *   mobile : shorter side < 500  → phones in any orientation, narrow windows
 *   desktop: width ≥ 1280 and not mobile
 *   tablet : everything else     → iPads + 9" Android tablets (e.g. Lenovo
 *            Tab M9 @ 1072×590, short side 590) in either orientation
 *
 * Thresholds tuned so the Lenovo Tab M9 (1072×590 CSS, DPR 1.25) lands in
 * tablet, not mobile (short side 590 ≥ 500) and not desktop (width 1072 < 1280).
 * Phone landscape short sides top out ~430, so they stay mobile.
 */
const MOBILE_MAX_SHORT_SIDE = 500;
const DESKTOP_MIN_WIDTH = 1280;

function computeBreakpoint(): Breakpoint {
  const shortSide = Math.min(window.innerWidth, window.innerHeight);
  if (shortSide < MOBILE_MAX_SHORT_SIDE) return "mobile";
  if (window.innerWidth >= DESKTOP_MIN_WIDTH) return "desktop";
  return "tablet";
}

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(computeBreakpoint);

  useEffect(() => {
    const update = () => { setBp(computeBreakpoint()); };
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return bp;
}
