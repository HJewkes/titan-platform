/**
 * Layer 1 of the precedence: what a field resolves to when no config layer sets it. Every
 * margin the gate applies is named here so none hides in a gate as a bare constant. A pool
 * must set its own ceiling and reserve, so those two entries only complete the record.
 */
export const LIMIT_DEFAULTS = {
  human_uses: false,
  ceiling_five_hour: 100,
  reserve_seven_day: 0,
  per_day_points: null as number | null,
  sonnet_band_points: 10,
  dispatch_seven_day_points: 2,
  dispatch_five_hour_points: 10,
  pick_margin_five_hour: 0,
  present_ceiling_five_hour: 70,
  present_within_minutes: 15,
} as const;

export type LayeredField = keyof typeof LIMIT_DEFAULTS;

export const LAYERED_FIELDS = Object.keys(LIMIT_DEFAULTS) as LayeredField[];

const PERCENT = { min: 0, max: 100 };
const NON_NEGATIVE = { min: 0, max: Number.POSITIVE_INFINITY };

/** The bounds `resolveLimits` clamps to and `checkLimits` reports against. */
export const LIMIT_BOUNDS: Partial<Record<LayeredField | "per_run_points", { min: number; max: number }>> = {
  ceiling_five_hour: PERCENT,
  reserve_seven_day: PERCENT,
  present_ceiling_five_hour: PERCENT,
  per_day_points: NON_NEGATIVE,
  per_run_points: NON_NEGATIVE,
  sonnet_band_points: NON_NEGATIVE,
  dispatch_seven_day_points: NON_NEGATIVE,
  dispatch_five_hour_points: NON_NEGATIVE,
  pick_margin_five_hour: NON_NEGATIVE,
  present_within_minutes: NON_NEGATIVE,
};

export function clampToBounds(field: string, value: number): number {
  const bounds = LIMIT_BOUNDS[field as keyof typeof LIMIT_BOUNDS];
  return bounds ? Math.min(bounds.max, Math.max(bounds.min, value)) : value;
}
