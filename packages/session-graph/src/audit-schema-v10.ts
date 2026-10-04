import type { Db } from "@titan-design/store-sqlite";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
export const REQUEST_COST_BOUNDARY_MIGRATION_NAME = "request_cost model-id boundary";

const DIGITS_8 = "[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]";
const REST = "substr(d.model, length(p.model) + 1)";

/**
 * The same rule as session-analytics `matchesAtBoundary`: the prefix is the whole id, or is followed
 * by `[..]`, or by `-YYYYMMDD` with an optional `[..]`. A bare prefix let `claude-opus-5` price an
 * unlisted `claude-opus-5-9` at its own rate, hiding it from `unpricedModels`. SQLite has no regex,
 * so `[[]` is GLOB's literal `[`.
 */
const AT_BOUNDARY = `substr(d.model, 1, length(p.model)) = p.model AND (
      ${REST} = '' OR ${REST} GLOB '[[]*'
      OR ${REST} GLOB '-${DIGITS_8}' OR ${REST} GLOB '-${DIGITS_8}[[]*]')`;

/**
 * The version 5 view with only the join condition changed; version 5 stays as written because a
 * migration body is frozen once applied. Longest prefix, then latest `effective_from`, still wins.
 */
const REQUEST_COST = `
  CREATE VIEW request_cost AS
  WITH candidate AS (
    SELECT d.request_id, p.model AS price_model, p.effective_from AS price_effective_from,
      p.input_usd_mtok, p.cache_read_usd_mtok, p.cache_write_5m_usd_mtok, p.cache_write_1h_usd_mtok, p.output_usd_mtok,
      ROW_NUMBER() OVER (PARTITION BY d.request_id ORDER BY length(p.model) DESC, p.effective_from DESC) AS match_rank
    FROM request_dedup d
    JOIN price p ON ${AT_BOUNDARY} AND p.effective_from <= d.ts
  ), component AS (
    SELECT d.*, c.price_model, c.price_effective_from, c.price_model IS NOT NULL AS priced,
      COALESCE(d.input_tokens * c.input_usd_mtok, 0) / 1e6 AS input_cost_usd,
      COALESCE(d.cache_read_tokens * c.cache_read_usd_mtok, 0) / 1e6 AS cache_read_cost_usd,
      COALESCE(CASE WHEN d.cache_creation_5m + d.cache_creation_1h = 0 THEN d.cache_creation_tokens ELSE d.cache_creation_5m END
        * c.cache_write_5m_usd_mtok, 0) / 1e6 AS cache_write_5m_cost_usd,
      COALESCE(d.cache_creation_1h * c.cache_write_1h_usd_mtok, 0) / 1e6 AS cache_write_1h_cost_usd,
      COALESCE(d.output_tokens * c.output_usd_mtok, 0) / 1e6 AS output_cost_usd
    FROM request_dedup d
    LEFT JOIN candidate c ON c.request_id = d.request_id AND c.match_rank = 1
  )
  SELECT *,
    input_cost_usd + cache_read_cost_usd + cache_write_5m_cost_usd + cache_write_1h_cost_usd + output_cost_usd AS cost_usd,
    (cache_read_tokens < 0.2 * context_tokens AND cache_creation_tokens >= 20000) AS is_cold,
    CASE WHEN context_tokens < 50000 THEN '<50k' WHEN context_tokens < 100000 THEN '50-100k'
      WHEN context_tokens < 200000 THEN '100-200k' ELSE '200k+' END AS context_band,
    CASE WHEN gap_ms IS NULL THEN NULL WHEN gap_ms < 300000 THEN '<5m'
      WHEN gap_ms < 3600000 THEN '5-60m' ELSE '>60m' END AS gap_band
  FROM component;
`;

/** DDL only: `request_cost` is a view, so recreating it rewrites no row. */
export function applyRequestCostBoundary(db: Db): void {
  db.exec("DROP VIEW IF EXISTS request_cost");
  db.exec(REQUEST_COST);
}
