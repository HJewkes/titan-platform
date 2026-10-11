import { existsSync } from "node:fs";
import { priceRequest } from "@titan-design/session-analytics";
import { claudeSourceFromPath, summarizeSession, type SessionUsageSummary } from "@titan-design/session-read";

export interface ReviewCost {
  /** List-price dollars over the reviewer session's own requests; subagent transcripts are not added. */
  usd: number;
  inputTokens: number;
  outputTokens: number;
  /** False when some model in the session has no price row, so `usd` reads low. */
  priced: boolean;
}

export interface TranscriptRef {
  path: string;
  namespace: string;
}

/** Prices the transcript the verdict's locator names; undefined when it is not on this machine or cannot be read. */
export type CostOf = (transcript: TranscriptRef, at: string) => Promise<ReviewCost | undefined>;

/** session-read's `input` already includes cache reads and writes; the price table charges each apart. */
function priceSummary(summary: SessionUsageSummary, at: string) {
  const { input, output, cachedInput, cacheWriteInput } = summary.tokens;
  const cacheRead = cachedInput ?? 0;
  const cacheWrite = cacheWriteInput ?? 0;
  const tokens = { inputTokens: Math.max((input ?? 0) - cacheRead - cacheWrite, 0), outputTokens: output ?? 0, cacheReadTokens: cacheRead, cacheCreationTokens: cacheWrite };
  return priceRequest(tokens, summary.model ?? "", at);
}

export const transcriptCost: CostOf = async ({ path, namespace }, at) => {
  if (!existsSync(path)) return undefined;
  try {
    const { usage } = await summarizeSession(claudeSourceFromPath(path, namespace));
    const priced = usage.map((summary) => priceSummary(summary, at));
    return {
      usd: priced.reduce((sum, price) => sum + price.costUsd, 0),
      inputTokens: usage.reduce((sum, summary) => sum + (summary.tokens.input ?? 0), 0),
      outputTokens: usage.reduce((sum, summary) => sum + (summary.tokens.output ?? 0), 0),
      priced: priced.every((price) => price.priced),
    };
  } catch {
    return undefined;
  }
};
