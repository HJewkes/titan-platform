import type { ParsedLimits } from "./parse.js";
import type { PaceLimits } from "./schema.js";

/** Mirrors agent-chat's `PACE_BUFFER_POINTS` (3) and `FINISH_EARLY_MS` (one day); change them together. */
export const PACE_DEFAULTS = {
  mode: "shadow",
  buffer_points: 3,
  finish_hours_before_reset: 24,
} as const satisfies Required<PaceLimits>;

export type ResolvedPace = { present: false } | ({ present: true } & Required<PaceLimits>);

/** `{ present: false }` when the block has no valid `pace`, so callers fall back to their own setting. */
export function resolvePace(parsed: ParsedLimits): ResolvedPace {
  const { pace } = parsed.limits;
  if (pace === undefined) return { present: false };
  return { present: true, ...PACE_DEFAULTS, ...pace };
}
