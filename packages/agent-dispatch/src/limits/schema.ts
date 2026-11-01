import { z } from "zod";

const points = z.number().finite();
const until = z.iso.datetime({ offset: true });
const names = z.array(z.string().min(1));

/** Matches agent-chat's burndown `BRIEF_GATES`; the two must change together. */
export const BRIEF_GATES = ["off", "shadow", "on"] as const;

/** Fields every layer from `defaults` to an override may set. Keys stay snake_case to match the gate's `PoolRule`. */
const tunableFields = {
  ceiling_five_hour: points.optional(),
  reserve_seven_day: points.optional(),
  /** @deprecated The pace controller replaces it (TP-2425). Still parsed and resolved until agent-chat drops its reader. */
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
  /** @deprecated The pace controller replaces it (TP-2425). Still parsed and resolved. */
  per_run_points: points.optional(),
  /** @deprecated The pace controller replaces it (TP-2425). Still parsed and resolved. */
  per_day_points: points.optional(),
  implementers: z.number().int().nonnegative().optional(),
  hand_reserve: z.number().int().nonnegative().optional(),
  brief_gate: z.enum(BRIEF_GATES).optional(),
});

const slots = z.number().int().nonnegative();
const load = z.number().finite().positive();

/** Host-wide agent and worktree slots. Each field is optional so the product's own default stands when unset. */
export const capacitySchema = z.strictObject({
  max_agents: z.number().int().positive().optional(),
  reserve_slots: slots.optional(),
  max_worktrees_per_repo: z.number().int().positive().optional(),
  reserve_worktrees: slots.optional(),
});

export const shepherdSchema = z.strictObject({
  spawn_gate: z
    .strictObject({ load5: load.optional(), build_load5: load.optional() })
    .optional(),
  review: z.strictObject({ max_concurrent: z.number().int().positive().optional() }).optional(),
});

export const PACE_MODES = ["off", "shadow", "on"] as const;

/** The pace controller's mode and tuning. Omitted fields take `PACE_DEFAULTS` through `resolvePace`. */
export const paceSchema = z.strictObject({
  mode: z.enum(PACE_MODES),
  buffer_points: z.number().finite().nonnegative().optional(),
  finish_hours_before_reset: z.number().finite().min(0).max(168).optional(),
});

/** In an override, `per_day_points: null` lifts the cap for the override's lifetime. */
export const overrideSchema = z.strictObject({
  ...tunableFields,
  /** @deprecated The pace controller replaces it (TP-2425). Still parsed and resolved. */
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
  capacity: capacitySchema.optional(),
  shepherd: shepherdSchema.optional(),
  pace: paceSchema.optional(),
});

export type Limits = z.infer<typeof limitsSchema>;
export type CapacityLimits = z.infer<typeof capacitySchema>;
export type ShepherdLimits = z.infer<typeof shepherdSchema>;
export type PaceLimits = z.infer<typeof paceSchema>;
export type PaceMode = (typeof PACE_MODES)[number];
export type BriefGate = (typeof BRIEF_GATES)[number];
export type LimitsDefaults = z.infer<typeof defaultsSchema>;
export type PoolLimits = z.infer<typeof poolSchema>;
export type ProfileLimits = z.infer<typeof profileSchema>;
export type SeatLimits = z.infer<typeof seatSchema>;
export type LimitsOverride = z.infer<typeof overrideSchema>;
export type Lift = z.infer<typeof liftSchema>;
export type Grant = z.infer<typeof grantSchema>;
export type TunableFields = { [K in keyof typeof tunableFields]?: number };
