import type { Db } from "@titan-design/store-sqlite";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
export const SESSION_COST_MIGRATION_NAME = "session cost rollup";

export const SESSION_COST_TABLE = "session_cost";

const SESSION_COST_DDL = `
  CREATE TABLE IF NOT EXISTS session_cost (
    session_id TEXT PRIMARY KEY,
    requests INTEGER NOT NULL,
    usd REAL NOT NULL,
    unpriced INTEGER NOT NULL,   -- requests whose model matched no price row; they cost 0
    first_ts TEXT,
    last_ts TEXT
  )`;

const AGGREGATE = `
  SELECT session_id, COUNT(*), COALESCE(SUM(cost_usd), 0), COALESCE(SUM(NOT priced), 0), MIN(ts), MAX(ts)`;

/** Every session at once, read through `request_cost`, whose window functions cannot take a session filter. */
const FILL_ALL = `INSERT INTO session_cost ${AGGREGATE} FROM request_cost GROUP BY session_id`;

export function applySessionCostSchema(db: Db): void {
  db.exec(SESSION_COST_DDL);
  db.exec(FILL_ALL);
}

/** Drop and refill every row: a price change moves the cost of requests in any session. */
export function rebuildSessionCost(db: Db): void {
  db.exec("DELETE FROM session_cost");
  db.exec(FILL_ALL);
}

const DIGITS_8 = "[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]";
const REST = "substr(d.model, length(p.model) + 1)";
const AT_BOUNDARY = `substr(d.model, 1, length(p.model)) = p.model AND (
      ${REST} = '' OR ${REST} GLOB '[[]*'
      OR ${REST} GLOB '-${DIGITS_8}' OR ${REST} GLOB '-${DIGITS_8}[[]*]')`;
const IS_LONG = "p.long_prompt_above_tokens IS NOT NULL AND d.context_tokens > p.long_prompt_above_tokens";
const rate = (column: string) => `CASE WHEN ${IS_LONG} THEN p.long_${column} ELSE p.${column} END AS ${column}`;

/**
 * The `request_cost` pricing rules (longest model prefix at an id boundary, latest `effective_from`,
 * long-prompt tier, split-less cache write at the 5m rate) over only the requests of `@sessionIds`.
 * `request_dedup` is rebuilt here for just those sessions: a copy keeps rank by `(ts, transcript_id)`
 * across every copy of its request id, so a fan-out copy in another transcript still loses to the earliest.
 * Keep in step with the `request_cost` view; the test compares the two.
 */
const SCOPED_COST = `
  WITH scope AS (SELECT value AS session_id FROM json_each(@sessionIds)),
  d AS (
    SELECT * FROM (
      SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.request_id ORDER BY r.ts, r.transcript_id) AS copy_rank
      FROM request r WHERE r.request_id IN (SELECT request_id FROM request WHERE session_id IN (SELECT session_id FROM scope))
    ) WHERE copy_rank = 1 AND session_id IN (SELECT session_id FROM scope)
  ),
  candidate AS (
    SELECT d.request_id, ${rate("input_usd_mtok")}, ${rate("cache_read_usd_mtok")}, ${rate("cache_write_5m_usd_mtok")},
      ${rate("cache_write_1h_usd_mtok")}, ${rate("output_usd_mtok")},
      ROW_NUMBER() OVER (PARTITION BY d.request_id ORDER BY length(p.model) DESC, p.effective_from DESC) AS match_rank
    FROM d JOIN price p ON ${AT_BOUNDARY} AND p.effective_from <= d.ts
  ),
  priced AS (
    SELECT d.session_id, d.ts, c.request_id IS NOT NULL AS priced,
      COALESCE(d.input_tokens * c.input_usd_mtok, 0) / 1e6
      + COALESCE(d.cache_read_tokens * c.cache_read_usd_mtok, 0) / 1e6
      + COALESCE(CASE WHEN d.cache_creation_5m + d.cache_creation_1h = 0 THEN d.cache_creation_tokens ELSE d.cache_creation_5m END
          * c.cache_write_5m_usd_mtok, 0) / 1e6
      + COALESCE(d.cache_creation_1h * c.cache_write_1h_usd_mtok, 0) / 1e6
      + COALESCE(d.output_tokens * c.output_usd_mtok, 0) / 1e6 AS cost_usd
    FROM d LEFT JOIN candidate c ON c.request_id = d.request_id AND c.match_rank = 1
  )
  INSERT INTO session_cost ${AGGREGATE} FROM priced GROUP BY session_id`;

const DELETE_SCOPE = "DELETE FROM session_cost WHERE session_id IN (SELECT value FROM json_each(@sessionIds))";

/** Rewrites the rows of the sessions in a JSON array of ids, computed from their request rows alone. */
export function prepareSessionCostRollup(db: Db): (sessionIdsJson: string) => void {
  const clear = db.prepare(DELETE_SCOPE);
  const fill = db.prepare(SCOPED_COST);
  return (sessionIds) => {
    clear.run({ sessionIds });
    fill.run({ sessionIds });
  };
}
