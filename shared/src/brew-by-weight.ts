/**
 * Brew-by-Weight controller — Phase 1 Step 6.
 *
 * Approach informed by Beanconqueror (GPL-3.0). Original implementation.
 *
 * Algorithm (BC-inspired):
 *   For each weight sample during brewing:
 *     1. Collect the last N samples within windowMs
 *     2. Fit a linear regression over (time_s, weight_g) → slope in g/s
 *     3. Estimate lag: sample_interval_s + residual_lag_s
 *     4. Project: currentWeight + slope × lag_time_s
 *     5. If projected >= targetG → signal stop
 *
 * Why real timestamps on X-axis but windowMs/N for sample_interval_s:
 *   X-axis uses real timestamps for accurate slope under jittery polling.
 *   sample_interval_s is the *estimated* average polling latency, used
 *   only as part of the lag-time projection (independent from slope).
 */

// ---------------------------------------------------------------------------
// Pure helper — exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Least-squares linear regression slope over (x, y) point pairs.
 * Returns slope in units of y-per-x-unit (g/s when x is seconds).
 * Returns 0 if fewer than 2 points or all x-values are identical.
 */
export function linearRegressionSlope(points: [number, number][]): number {
  const n = points.length;
  if (n < 2) return 0;

  let sumX = 0, sumY = 0;
  for (const [x, y] of points) { sumX += x; sumY += y; }
  const xMean = sumX / n;
  const yMean = sumY / n;

  let num = 0, den = 0;
  for (const [x, y] of points) {
    num += (x - xMean) * (y - yMean);
    den += (x - xMean) ** 2;
  }

  return den === 0 ? 0 : num / den;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrewByWeightTelemetry {
  slopeGPerS: number;
  projectedWeightG: number;
  currentWeightG: number;
  sampleCount: number;
}

export type BrewByWeightResult =
  | { shouldStop: false; telemetry: BrewByWeightTelemetry | null }
  | { shouldStop: true;  telemetry: BrewByWeightTelemetry };

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

interface Sample {
  t: number; // absolute timestamp in ms
  w: number; // weight in grams
}

export class BrewByWeightController {
  private readonly targetG: number;
  private readonly windowMs: number;
  private readonly residualLagS: number;

  private samples: Sample[] = [];
  private stopped = false;

  constructor(targetG: number, windowMs: number, residualLagS: number) {
    this.targetG = targetG;
    this.windowMs = windowMs;
    this.residualLagS = residualLagS;
  }

  addSample(timestampMs: number, weightG: number): BrewByWeightResult {
    // After first stop: no further triggers
    if (this.stopped) {
      return { shouldStop: false, telemetry: null };
    }

    // Add and prune samples outside the window
    this.samples.push({ t: timestampMs, w: weightG });
    const cutoff = timestampMs - this.windowMs;
    while (this.samples.length > 1 && this.samples[0].t < cutoff) {
      this.samples.shift();
    }

    const n = this.samples.length;
    if (n < 2) {
      return { shouldStop: false, telemetry: null };
    }

    // Build regression points: x = seconds since first sample in window, y = weight
    const t0 = this.samples[0].t;
    const points: [number, number][] = this.samples.map((s) => [
      (s.t - t0) / 1000,
      s.w,
    ]);

    const slopeGPerS = linearRegressionSlope(points);

    // X-axis uses real timestamps for accurate slope under jittery polling.
    // sample_interval_s estimates the next poll cycle delay as the mean gap
    // between consecutive samples in the window (span / (n-1)).
    // This is independent from the slope and gives a stable ~250ms estimate
    // under uniform polling regardless of how many samples are in the window.
    // Using windowMs/n instead would inflate the estimate for small n (e.g.,
    // 500ms for n=2 with a 1000ms window), causing premature stop triggers.
    const spanS = (this.samples[n - 1].t - this.samples[0].t) / 1000;
    const sampleIntervalS = spanS / (n - 1);
    const lagTimeS = sampleIntervalS + this.residualLagS;

    const projectedWeightG = weightG + slopeGPerS * lagTimeS;

    const telemetry: BrewByWeightTelemetry = {
      slopeGPerS,
      projectedWeightG,
      currentWeightG: weightG,
      sampleCount: n,
    };

    if (projectedWeightG >= this.targetG) {
      this.stopped = true;
      return { shouldStop: true, telemetry };
    }

    return { shouldStop: false, telemetry };
  }
}
