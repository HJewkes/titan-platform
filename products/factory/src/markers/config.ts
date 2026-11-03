import { z } from "zod";

/**
 * The M1b marker shadow (TP-3111): off when absent or `enabled` is false. On, serve computes marker verdicts beside each
 * fact step and logs them to `factory_shadow_log`; it changes no run. `entryBudget` overrides the shadow's per-entry caps.
 * Read once at serve start.
 */
export const MarkersConfigSchema = z.strictObject({
  shadow: z.strictObject({
    enabled: z.boolean().default(false),
    entryBudget: z.strictObject({ evaluations: z.number().int().positive(), shadowMs: z.number().int().positive() }).optional(),
  }),
});

export type MarkersConfig = z.infer<typeof MarkersConfigSchema>;
