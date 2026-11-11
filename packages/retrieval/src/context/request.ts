import { z } from "zod";
import type { Degradation } from "../fail-open.js";
import type { FusedResult } from "../types.js";
import type { ContextCandidate, ContextEntry, DropReason } from "./plan.js";

const queryFields = {
  query: z.string(),
  limit: z.number().int().positive().optional(),
  rerank: z.boolean().optional(),
};

/** The serialisable part of the planner's `ContextBudget`: everything but the estimator. */
export const ContextBudgetSchema = z.strictObject({
  tokens: z.number().int().nonnegative(),
  quotas: z.record(z.string(), z.number().nonnegative()).optional(),
  defaultQuota: z.number().nonnegative().optional(),
  defaultTiers: z.record(z.string(), z.number().int().nonnegative()).optional(),
  maxTier: z.number().int().nonnegative().optional(),
});

/** One request shape for both modes, discriminated on `mode`. */
export const RetrievalRequestSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("list"), ...queryFields }),
  z.strictObject({ mode: z.literal("context"), ...queryFields, budget: ContextBudgetSchema }),
]);

export type RetrievalRequest = z.infer<typeof RetrievalRequestSchema>;

/** Loads one ranked result's renderings, cheapest (tier 0) first. */
export interface TierSource {
  tiers(result: FusedResult, signal?: AbortSignal): Promise<string[]>;
}

export interface RetrievalCallOptions {
  signal?: AbortSignal;
  /** Required in context mode. */
  tierSource?: TierSource;
  /** The category quotas and default tiers key on. Default: the result's first source. */
  categoryOf?: (result: FusedResult) => string;
  /** Token estimator for context mode. Default: `estimateTokens`, ceil(chars / 4). */
  estimateTokens?: (text: string) => number;
}

/** A failed tier load reports itself under this name in `degraded`. */
export const TIERS_STAGE = "tiers";

export type RetrievalDropReason = DropReason | "tier-error";

export interface RetrievalDropped {
  id: string;
  category: string;
  reason: RetrievalDropReason;
}

export interface ListResponse {
  mode: "list";
  results: FusedResult[];
  degraded: Degradation[];
  timingsMs: Record<string, number>;
}

export interface ContextResponse {
  mode: "context";
  entries: ContextEntry[];
  dropped: RetrievalDropped[];
  usedTokens: number;
  budgetTokens: number;
  degraded: Degradation[];
  timingsMs: Record<string, number>;
}

export type RetrievalResponse = ListResponse | ContextResponse;

export interface LoadedCandidates {
  candidates: ContextCandidate[];
  dropped: RetrievalDropped[];
  degradation?: Degradation;
}

/**
 * Load tiers for every ranked result at once. One that throws, sync or async, is dropped
 * as `tier-error` and the rest still plan, the way a failed retriever costs recall only.
 */
export async function loadCandidates(
  results: readonly FusedResult[],
  source: TierSource,
  categoryOf: (result: FusedResult) => string,
  signal?: AbortSignal,
): Promise<LoadedCandidates> {
  const settled = await Promise.allSettled(results.map(async (r) => source.tiers(r, signal)));
  const loaded: LoadedCandidates = { candidates: [], dropped: [] };
  const failures: string[] = [];
  settled.forEach((outcome, i) => {
    const result = results[i]!;
    const category = categoryOf(result);
    if (outcome.status === "fulfilled") {
      loaded.candidates.push({ id: result.id, category, score: result.score, tiers: outcome.value });
    } else {
      loaded.dropped.push({ id: result.id, category, reason: "tier-error" });
      failures.push(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
    }
  });
  if (failures.length > 0) loaded.degradation = tierDegradation(failures, results.length);
  return loaded;
}

function tierDegradation(failures: string[], total: number): Degradation {
  return { retriever: TIERS_STAGE, reason: "error", message: `${failures.length} of ${total} tier loads failed; first: ${failures[0]}` };
}
