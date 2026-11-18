import { existsSync } from "node:fs";
import { buildSessionTimeline } from "@titan-design/session-analytics";
import { claudeSourceFromPath, readSessionObservations, type NormalizedSessionObservation } from "@titan-design/session-read";

export interface ReviewCost {
  /** List-price dollars over the reviewer session's own requests; subagent transcripts are not added. */
  usd: number;
  inputTokens: number;
  outputTokens: number;
  /** False when some request has no price row, so `usd` reads low. */
  priced: boolean;
}

export interface TranscriptRef {
  path: string;
  namespace: string;
}

/** Prices the transcript the verdict's locator names; undefined when it is not on this machine or cannot be read. */
export type CostOf = (transcript: TranscriptRef, at: string) => Promise<ReviewCost | undefined>;

async function collect(source: ReturnType<typeof claudeSourceFromPath>): Promise<NormalizedSessionObservation[]> {
  const observations: NormalizedSessionObservation[] = [];
  for await (const observation of readSessionObservations(source)) observations.push(observation);
  return observations;
}

/** The timeline prices each request with its 5m/1h cache-write split, at the request's own time, so `at` is not needed. */
export const transcriptCost: CostOf = async ({ path, namespace }) => {
  if (!existsSync(path)) return undefined;
  try {
    const { totals } = buildSessionTimeline(await collect(claudeSourceFromPath(path, namespace)));
    const { input, cacheRead, cacheWrite, output } = totals.tokens;
    return {
      usd: totals.costUsd,
      inputTokens: input + cacheRead + cacheWrite,
      outputTokens: output,
      priced: totals.requests !== null && totals.unpricedRequests === 0,
    };
  } catch {
    return undefined;
  }
};
