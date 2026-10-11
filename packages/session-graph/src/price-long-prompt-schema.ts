import type { Db } from "@titan-design/store-sqlite";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
export const PRICE_LONG_PROMPT_MIGRATION_NAME = "price long-prompt tier";

const LONG_COLUMNS = [
  "long_prompt_above_tokens INTEGER",
  "long_input_usd_mtok REAL",
  "long_cache_read_usd_mtok REAL",
  "long_cache_write_5m_usd_mtok REAL",
  "long_cache_write_1h_usd_mtok REAL",
  "long_output_usd_mtok REAL",
];

// Copied from version 10, not imported: each migration body stays frozen even if a later one changes the rule.
const DIGITS_8 = "[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]";
const REST = "substr(d.model, length(p.model) + 1)";
const AT_BOUNDARY = `substr(d.model, 1, length(p.model)) = p.model AND (
      ${REST} = '' OR ${REST} GLOB '[[]*'
      OR ${REST} GLOB '-${DIGITS_8}' OR ${REST} GLOB '-${DIGITS_8}[[]*]')`;

/**
 * Claude Code bills every component of a request at the long rates once its prompt
 * (input + cache read + cache write, which is `context_tokens`) is strictly above the threshold,
 * output included. A row with no tier keeps its base rates.
 */
const IS_LONG = "p.long_prompt_above_tokens IS NOT NULL AND d.context_tokens > p.long_prompt_above_tokens";
const rate = (column: string) => `CASE WHEN ${IS_LONG} THEN p.long_${column} ELSE p.${column} END AS ${column}`;

/** The version 10 view with only the rate selection changed; version 10 stays as written because a migration body is frozen once applied. */
const REQUEST_COST = `
  CREATE VIEW request_cost AS
  WITH candidate AS (
    SELECT d.request_id, p.model AS price_model, p.effective_from AS price_effective_from,
      ${rate("input_usd_mtok")}, ${rate("cache_read_usd_mtok")}, ${rate("cache_write_5m_usd_mtok")},
      ${rate("cache_write_1h_usd_mtok")}, ${rate("output_usd_mtok")},
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

/** DDL only: the new columns are nullable and `request_cost` is a view, so no row is rewritten. */
export function applyPriceLongPrompt(db: Db): void {
  for (const column of LONG_COLUMNS) db.exec(`ALTER TABLE price ADD COLUMN ${column}`);
  db.exec("DROP VIEW IF EXISTS request_cost");
  db.exec(REQUEST_COST);
}
