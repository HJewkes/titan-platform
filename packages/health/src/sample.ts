import { z } from "zod";

/** `unknown` is a probe that could not decide, such as an error inside the probe itself; it is never up. */
export const SAMPLE_STATUSES = ["pass", "warn", "fail", "unknown"] as const;
export const sampleStatusSchema = z.enum(SAMPLE_STATUSES);
export type SampleStatus = z.infer<typeof sampleStatusSchema>;

/** One stored probe result. Strict, because it is the write schema of an append-only store. */
export const healthSampleSchema = z.strictObject({
  ts: z.iso.datetime({ offset: true }),
  target: z.string().min(1),
  kind: z.string().min(1),
  status: sampleStatusSchema,
  latencyMs: z.number().nonnegative().optional(),
  observed: z.record(z.string(), z.unknown()).optional(),
  output: z.string().optional(),
  source: z.string().min(1).default("probe"),
  /** Set only by imports, so a re-import is idempotent; probe rows leave it unset and are all kept. */
  dedupKey: z.string().min(1).optional(),
});
export type HealthSample = z.infer<typeof healthSampleSchema>;
export type HealthSampleInput = z.input<typeof healthSampleSchema>;
