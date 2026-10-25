import { z } from "zod";

export const SIM_TRACE_SCHEMA = "explainer.sim-trace/v1";

/** Steps a run may carry, so the frozen JSON stays small. */
export const MAX_SIM_STEPS = 64;

const ParamsSchema = z.record(z.string().min(1), z.number());

export const SimStepSchema = z.strictObject({
  i: z.number().int().nonnegative(),
  label: z.string().min(1).optional(),
  state: ParamsSchema,
});

export const StatSchema = z.strictObject({ value: z.number(), se: z.number().nonnegative() });

export const SimRunSchema = z.strictObject({
  steps: z.array(SimStepSchema).max(MAX_SIM_STEPS),
  stats: z.record(z.string().min(1), StatSchema).refine((stats) => Object.keys(stats).length > 0, "a run emits at least one statistic"),
});

export const SimAxisSchema = z.strictObject({ param: z.string().min(1), values: z.array(z.number()).min(1) });

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "a sha256 in lowercase hex");

export const SimTraceSchema = z.strictObject({
  schema: z.literal(SIM_TRACE_SCHEMA),
  model: z.string().min(1),
  version: z.string().min(1),
  doctrine: sha256Hex,
  seed: z.union([z.number(), z.string().min(1)]),
  params: ParamsSchema,
  sweep: SimAxisSchema,
  facet: SimAxisSchema.optional(),
  runs: z.array(SimRunSchema.extend({ at: ParamsSchema })).min(1),
  sha: sha256Hex,
});

/** One frame of a run's animation track; the view maps a time to a step index and needs nothing else. */
export type SimStep = z.infer<typeof SimStepSchema>;
/** A Monte Carlo statistic: its estimate and standard error. */
export type Stat = z.infer<typeof StatSchema>;
export type SimRun = z.infer<typeof SimRunSchema>;
export type SimAxis = z.infer<typeof SimAxisSchema>;
export type SimTrace = z.infer<typeof SimTraceSchema>;
export type SimTraceRun = SimTrace["runs"][number];
