import { z } from "zod";
import { isRepoKey } from "../shepherd/seats.js";

/**
 * The GitHub backstop (TP-3098). `enabled` is off until the bot's port is wired (TP-3431). The cadence is not set here: the
 * schedule (TP-3402) runs a pass every `github.pollingIntervalMs` or `github.backstopIntervalMs` by effective mode. `intervalMs`
 * is still accepted for one release so a config that sets it keeps loading, and serve logs it as ignored. `fullEvery` caps how
 * many passes a quiet repo may go without a GraphQL snapshot. `repos` are the `owner/name` repos it watches.
 */
export const ReconcilerConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  intervalMs: z.number().optional(),
  fullEvery: z.number().int().min(1).max(10).default(3),
  repos: z.array(z.string().refine(isRepoKey, "must be an owner/name repo")).default([]),
});

export type ReconcilerConfig = z.output<typeof ReconcilerConfigSchema>;

export const DEPRECATED_INTERVAL = "config.deprecated reconciler.intervalMs ignored; use github.backstopIntervalMs";

/** The log lines serve writes at start for reconciler keys the factory config sets but nothing reads. */
export function reconcilerDeprecations(config: { reconciler?: { intervalMs?: number } }): string[] {
  return config.reconciler?.intervalMs === undefined ? [] : [DEPRECATED_INTERVAL];
}

export function reconcilerConfig(config: { reconciler?: z.input<typeof ReconcilerConfigSchema> }): ReconcilerConfig {
  return ReconcilerConfigSchema.parse(config.reconciler ?? {});
}
