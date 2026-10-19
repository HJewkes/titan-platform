import { UsageMeasurement } from '../index.js';

/** USD per million tokens. Fitted against 392 `cost-state` rows in the 2026-09-20 audit. */
interface PriceRow {
    /** Matched at a model-id boundary: the id itself, or followed by a -YYYYMMDD or [..] suffix. */
    modelPrefix: string;
    /** ISO date. The latest row at or before a request's timestamp wins. */
    effectiveFrom: string;
    input: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    output: number;
    /** Rates for every component, output included, once the prompt is strictly above `abovePromptTokens`. */
    longPrompt?: LongPromptPrice;
}
/** Prompt tokens are input + cache read + cache write, the sum session-graph stores as `context_tokens`. */
interface LongPromptPrice {
    abovePromptTokens: number;
    input: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    output: number;
}
/** Bump on any edit to PRICE_TABLE. The cost report prints it in its footer. */
declare const PRICE_TABLE_VERSION = 4;
declare const PRICE_TABLE: readonly PriceRow[];
/**
 * The longest prefix that matches the model at an id boundary, then the latest row effective at `ts`.
 * Returns null for a model no row covers: an unknown model is unpriced, never defaulted,
 * because a default silently prices a new model at an old model's rate.
 */
declare function findPrice(model: string, ts: string, prices?: readonly PriceRow[]): PriceRow | null;

/** Raw token counts for one API request, as the transcript reports them. */
interface RequestTokens {
    inputTokens?: number;
    cacheReadTokens?: number;
    /** Total cache creation. Used only when the 5m/1h split is absent. */
    cacheCreationTokens?: number;
    cacheCreation5mTokens?: number;
    cacheCreation1hTokens?: number;
    outputTokens?: number;
}
interface PricedRequest {
    inputUsd: number;
    cacheReadUsd: number;
    cacheWrite5mUsd: number;
    cacheWrite1hUsd: number;
    outputUsd: number;
    costUsd: number;
    /** False when no price row covers the model. Every component is then zero. */
    priced: boolean;
}
declare function priceRequest(tokens: RequestTokens, model: string, ts: string, prices?: readonly PriceRow[]): PricedRequest;

/**
 * One dated rate row for a Codex model, in USD per million tokens. The package
 * ships no rows: pricing is product policy, and a checked-in table would go stale.
 */
interface CodexPriceRow {
    model: string;
    /** UTC date (YYYY-MM-DD) from which this row applies. */
    effectiveFrom: string;
    inputUsdPerMTok: number;
    cachedInputUsdPerMTok: number;
    outputUsdPerMTok: number;
}
declare function validateCodexPrices(prices: readonly CodexPriceRow[]): void;
/** Fills `cost` on measurements whose model has a row in force at `atMs`; others keep `cost: null`. */
declare function priceCodexUsage(measurements: readonly UsageMeasurement[], prices: readonly CodexPriceRow[], atMs: number): UsageMeasurement[];

export { type CodexPriceRow, type LongPromptPrice, PRICE_TABLE, PRICE_TABLE_VERSION, type PriceRow, type PricedRequest, type RequestTokens, findPrice, priceCodexUsage, priceRequest, validateCodexPrices };
