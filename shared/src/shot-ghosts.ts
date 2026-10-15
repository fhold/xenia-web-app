/**
 * Ghost curves — past shots drawn faintly behind the current one.
 *
 * Borrowed from Decent (who borrowed the idea from Tufte): every past shot of
 * the same brew definition is drawn as a thin, nearly transparent line. Where
 * many of them run together the result gets darker, so the current shot can be
 * read against the whole history instead of only against the previous one.
 *
 * This module is the pure part: putting shots of different length and sample
 * timing onto ONE common time grid. That is what makes the ghosts cheap to
 * draw (one path per shot, no interpolation in the renderer) and it is the
 * shape a percentile band would need later.
 *
 * Deliberately only pressure and flow. Temperature barely moves and weight is
 * monotonic — neither carries information as a cloud, and four ghosted series
 * are mud.
 */

/** Grid spacing. Samples arrive every ~370 ms, so 500 ms loses nothing visible. */
export const GHOST_GRID_MS = 500;

/** Hard cap on grid points (240 × 500 ms = 2 min) so one runaway shot cannot
 *  blow up the payload for everybody. */
export const GHOST_MAX_POINTS = 240;

export interface GhostSourceSample {
  elapsedMs: number;
  pressureBar: number | null;
  flowMlS: number | null;
}

export interface GhostSeries {
  /** Pressure (bar) per grid point; null where the shot has no data. */
  pressure: (number | null)[];
  /** Flow (ml/s ≈ g/s, scale-derived) per grid point. */
  flow: (number | null)[];
}

/** Two decimals — a ghost is drawn 1 px wide, more precision is pure payload. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Linear interpolation onto the grid 0, gridMs, 2·gridMs, …
 *
 * Outside the shot's own sample range the value stays null: a short shot's
 * ghost has to stop where the shot stopped, not run flat to the right edge and
 * pretend it was still brewing.
 */
function interpolate(
  points: { t: number; v: number }[],
  gridPoints: number,
  gridMs: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(gridPoints).fill(null);
  if (points.length === 0) return out;

  const first = points[0]!;
  const last = points[points.length - 1]!;
  let i = 0;
  for (let k = 0; k < gridPoints; k++) {
    const t = k * gridMs;
    if (t < first.t || t > last.t) continue;
    while (i < points.length - 1 && points[i + 1]!.t < t) i++;
    const a = points[i]!;
    const b = points[i + 1] ?? a;
    out[k] = b.t === a.t ? round2(a.v) : round2(a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t));
  }
  return out;
}

/**
 * Resample one shot onto the common grid.
 *
 * Each series is interpolated over its OWN non-null points: a frame that
 * carried pressure but no scale reading must not punch a hole into the
 * pressure ghost.
 */
export function resampleToGrid(
  samples: GhostSourceSample[],
  gridPoints: number,
  gridMs: number = GHOST_GRID_MS,
): GhostSeries {
  const pressurePts: { t: number; v: number }[] = [];
  const flowPts: { t: number; v: number }[] = [];
  for (const s of samples) {
    if (s.pressureBar !== null) pressurePts.push({ t: s.elapsedMs, v: s.pressureBar });
    if (s.flowMlS !== null) flowPts.push({ t: s.elapsedMs, v: s.flowMlS });
  }
  return {
    pressure: interpolate(pressurePts, gridPoints, gridMs),
    flow: interpolate(flowPts, gridPoints, gridMs),
  };
}

/** Grid points needed to cover `maxElapsedMs`, capped at GHOST_MAX_POINTS. */
export function gridPointsFor(maxElapsedMs: number, gridMs: number = GHOST_GRID_MS): number {
  if (maxElapsedMs <= 0) return 0;
  return Math.min(Math.floor(maxElapsedMs / gridMs) + 1, GHOST_MAX_POINTS);
}

/** Which past shots a ghost cloud was built from. */
export type GhostBasis = "brewdef" | "profile";

export interface GhostShot {
  id: number;
  pressure: (number | null)[];
  flow: (number | null)[];
}

export interface ShotGhosts {
  /** "brewdef" = provably the same brew definition, "profile" = same profile id. */
  basis: GhostBasis;
  gridMs: number;
  shots: GhostShot[];
}
