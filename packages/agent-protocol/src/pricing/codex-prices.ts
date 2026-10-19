import type { UsageMeasurement } from "../index.js";
import type { HarnessPriceCatalogRef, HarnessPriceQuote, HarnessPricingPort } from "../harness/pricing-port.js";

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

export interface CodexPricingPortOptions {
  readonly prices: readonly CodexPriceRow[];
  readonly catalog: Omit<HarnessPriceCatalogRef, "model" | "effectiveFrom">;
}

/** Pure caller-bound catalog. No bundled rates, catalog identity or native authority. */
export function createCodexPricingPort(options: CodexPricingPortOptions): HarnessPricingPort<"codex"> {
  const rows = freezeCodexRows(options.prices);
  const catalog = freezeCodexCatalog(options.catalog);
  return Object.freeze({
    harness: "codex" as const,
    quote: (measurement: UsageMeasurement, atMs: number) => quoteCodexUsage(measurement, atMs, rows, catalog),
  });
}

function freezeCodexRows(prices: readonly CodexPriceRow[]): readonly CodexPriceRow[] {
  const rows = prices.map(row => Object.freeze({
    model: row.model, effectiveFrom: row.effectiveFrom,
    inputUsdPerMTok: row.inputUsdPerMTok,
    cachedInputUsdPerMTok: row.cachedInputUsdPerMTok,
    outputUsdPerMTok: row.outputUsdPerMTok,
  }));
  validateCodexPrices(rows);
  return Object.freeze(rows);
}

function freezeCodexCatalog(supplied: CodexPricingPortOptions["catalog"]): CodexPricingPortOptions["catalog"] {
  const catalog = Object.freeze({
    id: supplied.id, version: supplied.version, provider: supplied.provider,
    matchingPolicy: Object.freeze({ id: supplied.matchingPolicy.id, version: supplied.matchingPolicy.version }),
    accountingPolicy: Object.freeze({ id: supplied.accountingPolicy.id, version: supplied.accountingPolicy.version }),
  });
  for (const value of [catalog.id, catalog.version, catalog.provider,
    catalog.matchingPolicy.id, catalog.matchingPolicy.version,
    catalog.accountingPolicy.id, catalog.accountingPolicy.version]) {
    if (typeof value !== "string" || value.length === 0) throw new TypeError("Codex pricing catalog references must be nonempty strings");
  }
  return catalog;
}

function quoteCodexUsage(
  measurement: UsageMeasurement,
  atMs: number,
  rows: readonly CodexPriceRow[],
  catalog: CodexPricingPortOptions["catalog"],
): HarnessPriceQuote {
  const cost = measurement.cost;
  if (cost !== null) return quoteExistingCodexCost(measurement, cost);
  if (!Number.isFinite(atMs)) return { status: "unpriced", reason: "event time is not finite" };
  if (measurement.model === null) return { status: "unpriced", reason: "model is unavailable" };
  const { input, cachedInput, output } = measurement.tokens;
  if (![input, cachedInput, output].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
    return { status: "unpriced", reason: "required token counts are unavailable or invalid" };
  }
  const row = rowInForce(rows, measurement.model, atMs);
  if (!row) return { status: "unpriced", reason: "no dated rate row matches the model" };
  const usd = costUsd(measurement, row);
  if (usd === undefined || !Number.isFinite(usd)) return { status: "unpriced", reason: "computed USD is not finite" };
  return {
    status: "priced", cost: { usd, kind: "estimate" },
    basis: { kind: "catalog", atMs, catalog: Object.freeze({ ...catalog, model: row.model, effectiveFrom: row.effectiveFrom }) },
  };
}

function quoteExistingCodexCost(
  measurement: UsageMeasurement,
  cost: unknown,
): HarnessPriceQuote {
  assertExistingCodexCost(cost);
  return cost.kind === "reported"
    ? { status: "priced", cost: { ...cost, kind: "reported" }, basis: { kind: "reported", source: measurement.source } }
    : { status: "priced", cost: { ...cost, kind: "estimate" }, basis: { kind: "existing_estimate", source: measurement.source } };
}

function assertExistingCodexCost(cost: unknown): asserts cost is NonNullable<UsageMeasurement["cost"]> {
  if (typeof cost !== "object" || cost === null || !("kind" in cost) ||
      (cost.kind !== "reported" && cost.kind !== "estimate")) throw new TypeError("existing cost kind must be reported or estimate");
  if (!("usd" in cost) || typeof cost.usd !== "number" || !Number.isFinite(cost.usd) || cost.usd < 0) {
    throw new TypeError("existing USD must be finite and nonnegative");
  }
}
