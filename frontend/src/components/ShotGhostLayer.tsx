/**
 * ShotGhostLayer — past shots drawn faintly behind the current one.
 *
 * Rendered through Recharts' <Customized>, which hands us the chart's own
 * scales. That is the whole point: no second copy of the axis maths that could
 * drift away from the real chart (the ghosts must line up with the measured
 * curve to the pixel, or the comparison lies).
 *
 * ⚠ One <path> PER SHOT, on purpose. The "denser where many shots agree" look
 * only happens because each path is composited separately and its alpha adds
 * up. Merging all ghosts into one path with sub-paths would paint the element
 * once and every crossing would stay equally pale — the effect would be gone.
 *
 * Only drawn for a finished shot (history detail / post-shot), never live: the
 * ghosts would have to slide with the moving x-window on every frame.
 */

import { memo, useId } from "react";
import type { ShotGhosts } from "../hooks/useShotGhosts.js";

/** Per-line alpha. A single ghost stays a hint, twenty make a cloud — but it has
 *  to survive a tablet screen in a bright kitchen, where 0.13 was invisible. */
const GHOST_ALPHA = 0.2;
const GHOST_WIDTH = 1;

/** Injected by Recharts' <Customized> — the live chart geometry. */
interface InjectedChartProps {
  xAxisMap?: Record<string, { scale?: (v: number) => number }>;
  yAxisMap?: Record<string, { scale?: (v: number) => number }>;
  /** Plot area — ghosts longer than the current shot end at the axis, not past it. */
  offset?: { left: number; top: number; width: number; height: number };
}

interface ShotGhostLayerProps extends InjectedChartProps {
  ghosts: ShotGhosts | null;
  /** Axis colours, passed in so the layer holds no theme of its own. */
  pressureColor: string;
  flowColor: string;
}

/**
 * Build one SVG path per ghost series. A null grid point ends the current
 * sub-path — a shot that stopped early must not be connected across the gap.
 */
function buildPaths(
  values: (number | null)[],
  gridMs: number,
  xScale: (v: number) => number,
  yScale: (v: number) => number,
): string {
  let d = "";
  let pen = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined) {
      pen = false;
      continue;
    }
    const x = xScale((i * gridMs) / 1000);
    const y = yScale(v);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

function ShotGhostLayerInner({
  ghosts,
  pressureColor,
  flowColor,
  xAxisMap,
  yAxisMap,
  offset,
}: ShotGhostLayerProps) {
  const clipId = `ghost-clip-${useId().replace(/:/g, "")}`;
  const xScale = xAxisMap?.["0"]?.scale;
  const yScale = yAxisMap?.["main"]?.scale;
  if (!ghosts || ghosts.shots.length === 0 || !xScale || !yScale) return null;

  return (
    <g pointerEvents="none" clipPath={offset ? `url(#${clipId})` : undefined}>
      {offset && (
        <defs>
          <clipPath id={clipId}>
            <rect x={offset.left} y={offset.top} width={offset.width} height={offset.height} />
          </clipPath>
        </defs>
      )}
      {ghosts.shots.map((g) => {
        const dPressure = buildPaths(g.pressure, ghosts.gridMs, xScale, yScale);
        const dFlow = buildPaths(g.flow, ghosts.gridMs, xScale, yScale);
        return (
          <g key={g.id}>
            {dPressure !== "" && (
              <path
                d={dPressure}
                fill="none"
                stroke={pressureColor}
                strokeOpacity={GHOST_ALPHA}
                strokeWidth={GHOST_WIDTH}
                strokeLinejoin="round"
              />
            )}
            {dFlow !== "" && (
              <path
                d={dFlow}
                fill="none"
                stroke={flowColor}
                strokeOpacity={GHOST_ALPHA}
                strokeWidth={GHOST_WIDTH}
                strokeLinejoin="round"
              />
            )}
          </g>
        );
      })}
    </g>
  );
}

export const ShotGhostLayer = memo(ShotGhostLayerInner);
