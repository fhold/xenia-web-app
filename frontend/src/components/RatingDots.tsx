/**
 * RatingDots — read-only 1–5 rating as five dots (filled = accent).
 * Shared by the History detail, history card and recent-shot card.
 */

import theme from "../theme.js";

const C = theme;

export function RatingDots({ rating, size = 9 }: { rating: number; size?: number }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= rating;
        return (
          <span
            key={n}
            style={{
              width: size,
              height: size,
              borderRadius: "50%",
              background: filled ? C.acc : "transparent",
              border: `1px solid ${filled ? C.acc : C.bdrL}`,
              flexShrink: 0,
            }}
          />
        );
      })}
    </span>
  );
}
