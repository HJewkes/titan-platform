/** USD per million tokens. Fitted against 392 `cost-state` rows in the 2026-09-20 audit. */
export interface PriceRow {
  /** Matched against the model string by longest prefix. */
  modelPrefix: string;
  /** ISO date. The latest row at or before a request's timestamp wins. */
  effectiveFrom: string;
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}

/** Bump on any edit to PRICE_TABLE. The cost report prints it in its footer. */
export const PRICE_TABLE_VERSION = 1;

const OPUS = { input: 5.0, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10.0, output: 25.0 };
const SONNET = { input: 2.0, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4.0, output: 10.0 };
// Fable's cache read is 0.025 of input, not the 0.1 every other model uses. Reading it as
// 0.1 overstated the 2026-09-20 audit by about $1,700; `fable-cache-read.test` pins the ratio.
const FABLE = { input: 10.0, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20.0, output: 50.0 };
const HAIKU = { input: 1.0, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2.0, output: 5.0 };
const FREE = { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 };

const GENESIS = "2026-01-01";

export const PRICE_TABLE: readonly PriceRow[] = [
  { modelPrefix: "claude-opus-5", effectiveFrom: GENESIS, ...OPUS },
  { modelPrefix: "claude-opus-4-8", effectiveFrom: GENESIS, ...OPUS },
  { modelPrefix: "claude-sonnet-5", effectiveFrom: GENESIS, ...SONNET },
  { modelPrefix: "claude-fable-5-1", effectiveFrom: GENESIS, ...FABLE },
  { modelPrefix: "claude-fable-5", effectiveFrom: GENESIS, ...FABLE },
  { modelPrefix: "claude-haiku-4-5", effectiveFrom: GENESIS, ...HAIKU },
  { modelPrefix: "<synthetic>", effectiveFrom: GENESIS, ...FREE },
];

/**
 * The longest prefix that matches the model, then the latest row effective at `ts`.
 * Returns null for a model no row covers: an unknown model is unpriced, never defaulted,
 * because a default silently prices a new model at an old model's rate.
 */
export function findPrice(model: string, ts: string, prices: readonly PriceRow[] = PRICE_TABLE): PriceRow | null {
  let best: PriceRow | null = null;
  for (const row of prices) {
    if (!model.startsWith(row.modelPrefix)) continue;
    if (row.effectiveFrom > ts) continue;
    if (best && !isBetterMatch(row, best)) continue;
    best = row;
  }
  return best;
}

function isBetterMatch(row: PriceRow, best: PriceRow): boolean {
  if (row.modelPrefix.length !== best.modelPrefix.length) return row.modelPrefix.length > best.modelPrefix.length;
  return row.effectiveFrom > best.effectiveFrom;
}
