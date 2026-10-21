import { z } from "zod";
import { isRepoKey } from "../shepherd/seats.js";

/** H-L29: under webhook the backstop runs every 5 to 10 minutes; TP-3099 owns the polling-mode bound. */
const WEBHOOK_INTERVAL_MS = { min: 300_000, max: 600_000 } as const;

/**
 * The GitHub backstop (TP-3098). `enabled` is off until the bot's port is wired (TP-3431). `intervalMs` is the tick period,
 * 5 minutes by default and bounded to 5-10 minutes under `github.sources: webhook`. `fullEvery` caps how many ticks a quiet
 * repo may go without a GraphQL snapshot. `repos` are the `owner/name` repos it watches.
 */
export const ReconcilerConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  intervalMs: z.number().int().positive().default(WEBHOOK_INTERVAL_MS.min),
  fullEvery: z.number().int().min(1).max(10).default(3),
  repos: z.array(z.string().refine(isRepoKey, "must be an owner/name repo")).default([]),
});

export type ReconcilerConfig = z.output<typeof ReconcilerConfigSchema>;

/** The factory config's cross-field check: the reconciler's interval against the configured sources mode. */
export function webhookIntervalProblem(config: { github?: { sources?: string }; reconciler?: { intervalMs?: number } }): string | undefined {
  if (config.github?.sources !== "webhook") return undefined;
  const intervalMs = config.reconciler?.intervalMs ?? WEBHOOK_INTERVAL_MS.min;
  if (intervalMs >= WEBHOOK_INTERVAL_MS.min && intervalMs <= WEBHOOK_INTERVAL_MS.max) return undefined;
  return `intervalMs must be ${WEBHOOK_INTERVAL_MS.min}-${WEBHOOK_INTERVAL_MS.max} under github.sources webhook`;
}

export function reconcilerConfig(config: { reconciler?: z.input<typeof ReconcilerConfigSchema> }): ReconcilerConfig {
  return ReconcilerConfigSchema.parse(config.reconciler ?? {});
}
