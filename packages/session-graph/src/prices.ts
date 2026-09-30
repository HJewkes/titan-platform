import type { SessionGraph } from "./graph.js";

/** USD per million tokens for one model prefix from one date. Shaped so session-analytics' `PRICE_TABLE` passes straight through. */
export interface PriceInput {
  /** Matched against `request.model` by longest prefix in `request_cost`. */
  modelPrefix: string;
  /** ISO date or timestamp; compared as text against `request.ts`. */
  effectiveFrom: string;
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}

export interface SyncPricesOptions {
  /** Stamped on every row so a report can name the table it priced with. */
  tableVersion: number;
  source?: string;
}

/** Replace every `price` row with `rows` in one transaction, so `request_cost` never reads a half-written table. */
export function syncPrices(graph: SessionGraph, rows: readonly PriceInput[], options: SyncPricesOptions): number {
  const insert = graph.db.prepare(
    `INSERT INTO price (model, effective_from, table_version, input_usd_mtok, cache_read_usd_mtok,
       cache_write_5m_usd_mtok, cache_write_1h_usd_mtok, output_usd_mtok, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const source = options.source ?? null;
  graph.db.transaction(() => {
    graph.db.exec("DELETE FROM price");
    for (const r of rows) {
      insert.run(r.modelPrefix, r.effectiveFrom, options.tableVersion, r.input, r.cacheRead, r.cacheWrite5m, r.cacheWrite1h, r.output, source);
    }
  })();
  return rows.length;
}

export interface ReconcileResult {
  added: number;
  updated: number;
}

/** Upsert `rows` into `price` without deleting others, stamping `tableVersion` on each; a graph already current is not written. */
export function reconcilePrices(graph: SessionGraph, rows: readonly PriceInput[], options: SyncPricesOptions): ReconcileResult {
  const find = graph.db.prepare("SELECT * FROM price WHERE model = ? AND effective_from = ?");
  const upsert = graph.db.prepare(
    `INSERT INTO price (model, effective_from, table_version, input_usd_mtok, cache_read_usd_mtok,
       cache_write_5m_usd_mtok, cache_write_1h_usd_mtok, output_usd_mtok, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (model, effective_from) DO UPDATE SET table_version = excluded.table_version,
       input_usd_mtok = excluded.input_usd_mtok, cache_read_usd_mtok = excluded.cache_read_usd_mtok,
       cache_write_5m_usd_mtok = excluded.cache_write_5m_usd_mtok, cache_write_1h_usd_mtok = excluded.cache_write_1h_usd_mtok,
       output_usd_mtok = excluded.output_usd_mtok, source = excluded.source`,
  );
  const source = options.source ?? null;
  const result: ReconcileResult = { added: 0, updated: 0 };
  graph.db.transaction(() => {
    for (const r of rows) {
      const values = [r.input, r.cacheRead, r.cacheWrite5m, r.cacheWrite1h, r.output];
      const stored = find.get(r.modelPrefix, r.effectiveFrom) as Record<string, number | string | null> | undefined;
      const current = stored && stored.table_version === options.tableVersion && stored.source === source
        && [stored.input_usd_mtok, stored.cache_read_usd_mtok, stored.cache_write_5m_usd_mtok, stored.cache_write_1h_usd_mtok, stored.output_usd_mtok]
          .every((v, i) => v === values[i]);
      if (current) continue;
      upsert.run(r.modelPrefix, r.effectiveFrom, options.tableVersion, ...values, source);
      if (stored) result.updated++;
      else result.added++;
    }
  })();
  return result;
}
