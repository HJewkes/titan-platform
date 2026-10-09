import { z } from "zod";

const points = z.number().finite();
const until = z.iso.datetime({ offset: true });
const names = z.array(z.string().min(1));

/** Fields every layer from `defaults` to an override may set. Keys stay snake_case to match the gate's `PoolRule`. */
const tunableFields = {
  ceiling_five_hour: points.optional(),
  reserve_seven_day: points.optional(),
  per_day_points: points.optional(),
  sonnet_band_points: points.optional(),
  dispatch_seven_day_points: points.optional(),
  dispatch_five_hour_points: points.optional(),
  pick_margin_five_hour: points.optional(),
};

export const liftSchema = z.strictObject({
  ceiling_five_hour: points,
  ask: z.literal("owner"),
});

export const defaultsSchema = z.strictObject({
  ...tunableFields,
  human_uses: z.boolean().optional(),
  present_ceiling_five_hour: points.optional(),
  present_within_minutes: points.optional(),
});

export const poolSchema = z.strictObject({
  ...tunableFields,
  config_dir: z.string().min(1),
  human_uses: z.boolean().optional(),
  ceiling_five_hour: points,
  reserve_seven_day: points,
  lift: liftSchema.optional(),
});

export const profileSchema = z.strictObject({
  ...tunableFields,
  pools: z.record(z.string(), z.strictObject(tunableFields)).optional(),
  band_fallback: z.string().min(1).optional(),
  context_tokens: z.number().int().positive().optional(),
});

export const seatSchema = z.strictObject({
  pool: z.string().min(1).optional(),
  overflow_pool: z.string().min(1).optional(),
  pools: names.optional(),
  per_run_points: points.optional(),
  per_day_points: points.optional(),
  implementers: z.number().int().nonnegative().optional(),
});

/** In an override, `per_day_points: null` lifts the cap for the override's lifetime. */
export const overrideSchema = z.strictObject({
  ...tunableFields,
  per_day_points: points.nullable().optional(),
  pools: names.optional(),
  profiles: names.optional(),
  seats: names.optional(),
  until,
  decision: z.string().min(1),
});

export const grantSchema = z.strictObject({
  pool: z.string().min(1),
  ceiling_five_hour: points,
  until,
  question: z.string().min(1),
});

export const limitsSchema = z.strictObject({
  version: z.literal(1),
  defaults: defaultsSchema.optional(),
  pools: z.record(z.string(), poolSchema),
  funds: z.record(z.string(), names).optional(),
  profiles: z.record(z.string(), profileSchema).optional(),
  seats: z.record(z.string(), seatSchema).optional(),
  overrides: z.array(overrideSchema).optional(),
});

export type Limits = z.infer<typeof limitsSchema>;
export type LimitsDefaults = z.infer<typeof defaultsSchema>;
export type PoolLimits = z.infer<typeof poolSchema>;
export type ProfileLimits = z.infer<typeof profileSchema>;
export type SeatLimits = z.infer<typeof seatSchema>;
export type LimitsOverride = z.infer<typeof overrideSchema>;
export type Lift = z.infer<typeof liftSchema>;
export type Grant = z.infer<typeof grantSchema>;
export type TunableFields = { [K in keyof typeof tunableFields]?: number };
