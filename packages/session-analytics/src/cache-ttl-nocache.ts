import type { PriceRow } from "./prices.js";
import type { TtlRequestRow } from "./cache-ttl.js";

const MTOK = 1e6;

/**
 * What no cache would save against what the request paid: every prompt token at the input rate, so
 * a read gives back its discount and a write its premium. Input tokens cancel, so the row omits them.
 */
export function noCacheSavingUsd(row: Pick<TtlRequestRow, "cacheReadTokens" | "cacheWrite5mTokens" | "cacheWrite1hTokens">, price: PriceRow): number {
  const readDiscount = row.cacheReadTokens * (price.cacheRead - price.input);
  const write5mPremium = row.cacheWrite5mTokens * (price.cacheWrite5m - price.input);
  const write1hPremium = row.cacheWrite1hTokens * (price.cacheWrite1h - price.input);
  return (readDiscount + write5mPremium + write1hPremium) / MTOK;
}
