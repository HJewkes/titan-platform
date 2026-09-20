import type { PriceRow } from "./prices.js";
import { PRICE_TABLE, findPrice } from "./prices.js";

/** Raw token counts for one API request, as the transcript reports them. */
export interface RequestTokens {
  inputTokens?: number;
  cacheReadTokens?: number;
  /** Total cache creation. Used only when the 5m/1h split is absent. */
  cacheCreationTokens?: number;
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
  outputTokens?: number;
}

export interface PricedRequest {
  inputUsd: number;
  cacheReadUsd: number;
  cacheWrite5mUsd: number;
  cacheWrite1hUsd: number;
  outputUsd: number;
  costUsd: number;
  /** False when no price row covers the model. Every component is then zero. */
  priced: boolean;
}

const UNPRICED: PricedRequest = {
  inputUsd: 0,
  cacheReadUsd: 0,
  cacheWrite5mUsd: 0,
  cacheWrite1hUsd: 0,
  outputUsd: 0,
  costUsd: 0,
  priced: false,
};

export function priceRequest(
  tokens: RequestTokens,
  model: string,
  ts: string,
  prices: readonly PriceRow[] = PRICE_TABLE,
): PricedRequest {
  const row = findPrice(model, ts, prices);
  if (!row) return { ...UNPRICED };

  const { write5m, write1h } = splitCacheCreation(tokens);
  const inputUsd = perMTok(tokens.inputTokens, row.input);
  const cacheReadUsd = perMTok(tokens.cacheReadTokens, row.cacheRead);
  const cacheWrite5mUsd = perMTok(write5m, row.cacheWrite5m);
  const cacheWrite1hUsd = perMTok(write1h, row.cacheWrite1h);
  const outputUsd = perMTok(tokens.outputTokens, row.output);
  const costUsd = inputUsd + cacheReadUsd + cacheWrite5mUsd + cacheWrite1hUsd + outputUsd;
  return { inputUsd, cacheReadUsd, cacheWrite5mUsd, cacheWrite1hUsd, outputUsd, costUsd, priced: true };
}

/**
 * Older transcripts carry a cache_creation total with no ttl breakdown. Charging the
 * 5m rate there under-reads rather than over-reads, and 5m is the harness default.
 */
function splitCacheCreation(tokens: RequestTokens): { write5m: number; write1h: number } {
  const write5m = tokens.cacheCreation5mTokens ?? 0;
  const write1h = tokens.cacheCreation1hTokens ?? 0;
  if (write5m > 0 || write1h > 0) return { write5m, write1h };
  return { write5m: tokens.cacheCreationTokens ?? 0, write1h: 0 };
}

function perMTok(tokens: number | undefined, ratePerMTok: number): number {
  return ((tokens ?? 0) * ratePerMTok) / 1_000_000;
}
