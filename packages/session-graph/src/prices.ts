import type { SessionGraph } from "./graph.js";

/** USD per million tokens for one model prefix from one date. Shaped so session-analytics' `PRICE_TABLE` passes straight through. */
export interface PriceInput {
  /** Matched against `request.model` in `request_cost` by longest prefix at an id boundary: the id itself, or followed by -YYYYMMDD, [..], or both as -YYYYMMDD[..]. */
  modelPrefix: string;
  /** ISO date or timestamp; compared as text against `request.ts`. */
  effectiveFrom: string;
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  /** Rates for the whole request, output included, once its prompt (`context_tokens`) is strictly above `abovePromptTokens`. */
  longPrompt?: LongPromptPrice;
}

export interface LongPromptPrice {
  abovePromptTokens: number;
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}

const RATE_COLUMNS = ["input_usd_mtok", "cache_read_usd_mtok", "cache_write_5m_usd_mtok", "cache_write_1h_usd_mtok", "output_usd_mtok",
  "long_prompt_above_tokens", "long_input_usd_mtok", "long_cache_read_usd_mtok", "long_cache_write_5m_usd_mtok",
  "long_cache_write_1h_usd_mtok", "long_output_usd_mtok"] as const;
const INSERT_PRICE = `INSERT INTO price (model, effective_from, table_version, source, ${RATE_COLUMNS.join(", ")})
     VALUES (${Array(4 + RATE_COLUMNS.length).fill("?").join(", ")})`;

/** In `RATE_COLUMNS` order; a row with no tier stores NULL long columns. */
function rates(r: PriceInput): (number | null)[] {
  const l = r.longPrompt;
  return [r.input, r.cacheRead, r.cacheWrite5m, r.cacheWrite1h, r.output,
    l?.abovePromptTokens ?? null, l?.input ?? null, l?.cacheRead ?? null, l?.cacheWrite5m ?? null, l?.cacheWrite1h ?? null, l?.output ?? null];
}

const priceValues = (r: PriceInput, tableVersion: number, source: string | null) =>
  [r.modelPrefix, r.effectiveFrom, tableVersion, source, ...rates(r)];

export interface SyncPricesOptions {
  /** Stamped on every row so a report can name the table it priced with. */
  tableVersion: number;
  source?: string;
}

/** Replace every `price` row with `rows` in one transaction, so `request_cost` never reads a half-written table. */
export function syncPrices(graph: SessionGraph, rows: readonly PriceInput[], options: SyncPricesOptions): number {
  const insert = graph.db.prepare(INSERT_PRICE);
  const source = options.source ?? null;
  graph.db.transaction(() => {
    graph.db.exec("DELETE FROM price");
    for (const r of rows) {
      insert.run(...priceValues(r, options.tableVersion, source));
    }
  })();
  return rows.length;
}

export interface ReconcileResult {
  added: number;
  updated: number;
  pruned: number;
}

type StoredPrice = Record<string, number | string | null>;

function matchesRow(stored: StoredPrice, r: PriceInput, version: number, source: string | null): boolean {
  const expected = rates(r);
  return stored.table_version === version && stored.source === source
    && RATE_COLUMNS.every((column, i) => stored[column] === expected[i]);
}

/**
 * Upsert `rows` into `price`, stamping `tableVersion`; a current graph is not written.
 * A stored row from a newer table version is left alone, so an older caller never downgrades rates.
 * With a `source`, rows of that source the table no longer names are pruned (a longer stale prefix would win in `request_cost`), unless a newer version wrote any of them.
 */
export function reconcilePrices(graph: SessionGraph, rows: readonly PriceInput[], options: SyncPricesOptions): ReconcileResult {
  const find = graph.db.prepare("SELECT * FROM price WHERE model = ? AND effective_from = ?");
  const upsert = graph.db.prepare(
    `${INSERT_PRICE}
     ON CONFLICT (model, effective_from) DO UPDATE SET table_version = excluded.table_version, source = excluded.source,
       ${RATE_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ")}`,
  );
  const source = options.source ?? null;
  const result: ReconcileResult = { added: 0, updated: 0, pruned: 0 };
  graph.db.transaction(() => {
    for (const r of rows) {
      const stored = find.get(r.modelPrefix, r.effectiveFrom) as StoredPrice | undefined;
      if (stored && (stored.table_version as number) > options.tableVersion) continue;
      if (stored && matchesRow(stored, r, options.tableVersion, source)) continue;
      upsert.run(...priceValues(r, options.tableVersion, source));
      if (stored) result.updated++;
      else result.added++;
    }
    if (source !== null) result.pruned = pruneAbsent(graph, rows, source, options.tableVersion);
  })();
  return result;
}

function pruneAbsent(graph: SessionGraph, rows: readonly PriceInput[], source: string, tableVersion: number): number {
  const owned = graph.db.prepare("SELECT model, effective_from, table_version FROM price WHERE source = ?").all(source) as
    { model: string; effective_from: string; table_version: number }[];
  if (owned.some((o) => o.table_version > tableVersion)) return 0;
  const keep = new Set(rows.map((r) => `${r.modelPrefix}\u0000${r.effectiveFrom}`));
  const drop = graph.db.prepare("DELETE FROM price WHERE model = ? AND effective_from = ?");
  let pruned = 0;
  for (const o of owned) {
    if (keep.has(`${o.model}\u0000${o.effective_from}`)) continue;
    drop.run(o.model, o.effective_from);
    pruned++;
  }
  return pruned;
}
