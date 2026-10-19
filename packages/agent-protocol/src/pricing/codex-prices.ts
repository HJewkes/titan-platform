import type { UsageMeasurement } from "../index.js";

/**
 * One dated rate row for a Codex model, in USD per million tokens. The package
 * ships no rows: pricing is product policy, and a checked-in table would go stale.
 */
export interface CodexPriceRow {
  model: string;
  /** UTC date (YYYY-MM-DD) from which this row applies. */
  effectiveFrom: string;
  inputUsdPerMTok: number;
  cachedInputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

const RATE_FIELDS = ["inputUsdPerMTok", "cachedInputUsdPerMTok", "outputUsdPerMTok"] as const;
const PER_MTOK = 1_000_000;

export function validateCodexPrices(prices: readonly CodexPriceRow[]): void {
  const seen = new Set<string>();
  for (const row of prices) {
    if (typeof row.model !== "string" || row.model.length === 0) throw new TypeError("price row needs a model");
    if (effectiveFromMs(row.effectiveFrom) === undefined) {
      throw new TypeError(`price row for ${row.model} has a bad effectiveFrom: ${String(row.effectiveFrom)}`);
    }
    for (const field of RATE_FIELDS) {
      const rate = row[field];
      if (!Number.isFinite(rate) || rate < 0) {
        throw new TypeError(`price row for ${row.model} needs a finite nonnegative ${field}`);
      }
    }
    const key = `${row.model}\u0000${row.effectiveFrom}`;
    if (seen.has(key)) throw new TypeError(`duplicate price row for ${row.model} at ${row.effectiveFrom}`);
    seen.add(key);
  }
}

/** Fills `cost` on measurements whose model has a row in force at `atMs`; others keep `cost: null`. */
export function priceCodexUsage(
  measurements: readonly UsageMeasurement[],
  prices: readonly CodexPriceRow[],
  atMs: number,
): UsageMeasurement[] {
  return measurements.map((measurement) => {
    if (measurement.cost !== null || measurement.model === null) return measurement;
    const row = rowInForce(prices, measurement.model, atMs);
    const usd = row ? costUsd(measurement, row) : undefined;
    return usd === undefined ? measurement : { ...measurement, cost: { usd, kind: "estimate" } };
  });
}

function rowInForce(prices: readonly CodexPriceRow[], model: string, atMs: number): CodexPriceRow | undefined {
  let best: { row: CodexPriceRow; from: number } | undefined;
  for (const row of prices) {
    const from = effectiveFromMs(row.effectiveFrom);
    if (row.model !== model || from === undefined || from > atMs) continue;
    if (!best || from > best.from) best = { row, from };
  }
  return best?.row;
}

// Codex input_tokens includes cached tokens, and output_tokens already includes
// reasoning tokens, so neither subset is billed a second time.
function costUsd(measurement: UsageMeasurement, row: CodexPriceRow): number | undefined {
  const { input, cachedInput, output } = measurement.tokens;
  if (input === null || cachedInput === null || output === null) return undefined;
  const uncached = Math.max(0, input - cachedInput);
  const cached = Math.min(cachedInput, input);
  return (
    (uncached * row.inputUsdPerMTok + cached * row.cachedInputUsdPerMTok + output * row.outputUsdPerMTok) / PER_MTOK
  );
}

function effectiveFromMs(date: string): number | undefined {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) return undefined;
  return ms;
}
