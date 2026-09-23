import { AUDIT_FACET, EPISODE_TABLE, FACET_TABLE, KIT } from "@titan-design/session-graph";
import type { Db } from "@titan-design/store-sqlite";
import type { SessionFacts } from "./classify-session.js";
import type { TaskInitiative } from "./initiative.js";

/** ISO bounds on request `ts`: `since` inclusive, `until` exclusive, null for open. */
export interface ReportWindow {
  since: string | null;
  until: string | null;
}

/** One deduplicated, priced request as the `request_cost` view returns it. */
export interface CostRow {
  sessionId: string;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  inputCostUsd: number;
  cacheReadCostUsd: number;
  cacheWrite5mCostUsd: number;
  cacheWrite1hCostUsd: number;
  outputCostUsd: number;
  costUsd: number;
  priced: boolean;
  isCold: boolean;
  contextBand: string;
  gapBand: string | null;
  wakeCause: string | null;
  wakeDelivery: string | null;
}

/** What the report needs about one session beyond its requests. */
export interface SessionContext {
  facts: SessionFacts;
  cwd: string | null;
  account: string | null;
  tasks: TaskInitiative[];
  /** First to last main-thread request over the whole session, not just the window. */
  lifetimeMs: number;
  /** Stored episode rows of every heuristic, in episode order. */
  episodes: StoredEpisode[];
}

export interface StoredEpisode {
  heuristic: string;
  openedBy: string;
}

export interface CompactionRow {
  trigger: string | null;
  midLoop: boolean;
  droppedTokens: number | null;
}

const IN_WINDOW = "(@since IS NULL OR ts >= @since) AND (@until IS NULL OR ts < @until)";
const IN_SESSIONS = "session_id IN (SELECT value FROM json_each(@ids))";

// The 5m write column mirrors the view: a split-less write is billed at the 5m rate.
const COST_ROWS = `
  SELECT session_id AS sessionId, model,
    input_tokens AS inputTokens, cache_read_tokens AS cacheReadTokens,
    CASE WHEN cache_creation_5m + cache_creation_1h = 0 THEN cache_creation_tokens ELSE cache_creation_5m END AS cacheWrite5mTokens,
    cache_creation_1h AS cacheWrite1hTokens, output_tokens AS outputTokens,
    input_cost_usd AS inputCostUsd, cache_read_cost_usd AS cacheReadCostUsd,
    cache_write_5m_cost_usd AS cacheWrite5mCostUsd, cache_write_1h_cost_usd AS cacheWrite1hCostUsd,
    output_cost_usd AS outputCostUsd, cost_usd AS costUsd, priced, is_cold AS isCold,
    context_band AS contextBand, gap_band AS gapBand, wake_cause AS wakeCause, wake_delivery AS wakeDelivery
  FROM request_cost WHERE ${IN_WINDOW}
`;

export function readCostRows(db: Db, window: ReportWindow): CostRow[] {
  const rows = db.prepare(COST_ROWS).all(window) as (Omit<CostRow, "priced" | "isCold"> & { priced: number; isCold: number })[];
  return rows.map((row) => ({ ...row, priced: row.priced === 1, isCold: row.isCold === 1 }));
}

export function readCompactions(db: Db, window: ReportWindow): CompactionRow[] {
  const sql = `SELECT trigger, mid_loop AS midLoop, dropped_tokens AS droppedTokens FROM compaction WHERE ${IN_WINDOW}`;
  const rows = db.prepare(sql).all(window) as (Omit<CompactionRow, "midLoop"> & { midLoop: number | null })[];
  return rows.map((row) => ({ ...row, midLoop: row.midLoop === 1 }));
}

/** The graph's own price version, which is what `request_cost` priced with; null before any price row exists. */
export function readPriceTableVersion(db: Db): number | null {
  return (db.prepare("SELECT MAX(table_version) AS version FROM price").get() as { version: number | null }).version;
}

/** Indexed transcripts, and those whose audit facet is missing or older than `facetVersion`. */
export function readCoverage(db: Db, facetVersion: number | null): { transcriptsIndexed: number; facetBacklog: number } {
  const indexed = db.prepare(`SELECT COUNT(*) AS n FROM "${KIT.watermark}"`).get() as { n: number };
  const backlog = db
    .prepare(
      `SELECT COUNT(*) AS n FROM "${KIT.watermark}" t LEFT JOIN "${FACET_TABLE}" f
         ON f.transcript_id = t.source_id AND f.facet = @facet AND (@version IS NULL OR f.version >= @version)
       WHERE f.transcript_id IS NULL`,
    )
    .get({ facet: AUDIT_FACET, version: facetVersion }) as { n: number };
  return { transcriptsIndexed: indexed.n, facetBacklog: backlog.n };
}

export function readSessionContexts(db: Db, sessionIds: readonly string[]): Map<string, SessionContext> {
  const ids = JSON.stringify(sessionIds);
  const contexts = new Map<string, SessionContext>(sessionIds.map((id) => [id, emptyContext()]));
  addSessionRows(db, ids, contexts);
  addOrigins(db, ids, contexts);
  addInbounds(db, ids, contexts);
  addSignals(db, ids, contexts);
  addTaskInitiatives(db, ids, contexts);
  addLifetimes(db, ids, contexts);
  addEpisodes(db, ids, contexts);
  return contexts;
}

function emptyContext(): SessionContext {
  return { facts: { inboundKinds: [], signalKinds: [], humanTurnCount: 0 }, cwd: null, account: null, tasks: [], lifetimeMs: 0, episodes: [] };
}

function addSessionRows(db: Db, ids: string, contexts: Map<string, SessionContext>): void {
  const sql = `SELECT session_id AS sessionId, start_type AS startType, cwd, seed_prompt AS seedPrompt, account FROM session WHERE ${IN_SESSIONS}`;
  type Row = { sessionId: string; startType: string | null; cwd: string | null; seedPrompt: string | null; account: string | null };
  for (const row of db.prepare(sql).all({ ids }) as Row[]) {
    const context = contexts.get(row.sessionId)!;
    context.cwd = row.cwd;
    context.account = row.account;
    context.facts.startType = row.startType;
    context.facts.firstUserText = row.seedPrompt;
  }
}

function addOrigins(db: Db, ids: string, contexts: Map<string, SessionContext>): void {
  const sql = `SELECT session_id AS sessionId, depth, parent_name AS parentName, origin_kind AS originKind, profile FROM session_origin WHERE ${IN_SESSIONS}`;
  type Row = { sessionId: string; depth: number | null; parentName: string | null; originKind: string | null; profile: string | null };
  for (const { sessionId, depth, ...origin } of db.prepare(sql).all({ ids }) as Row[]) {
    contexts.get(sessionId)!.facts.origin = { ...origin, depth: depth ?? 0 };
  }
}

function addInbounds(db: Db, ids: string, contexts: Map<string, SessionContext>): void {
  const sql = `SELECT session_id AS sessionId, cause, SUM(delivery = 'turn_start') AS turnStarts FROM inbound WHERE ${IN_SESSIONS} GROUP BY session_id, cause`;
  for (const row of db.prepare(sql).all({ ids }) as { sessionId: string; cause: string; turnStarts: number }[]) {
    const facts = contexts.get(row.sessionId)!.facts;
    facts.inboundKinds = [...(facts.inboundKinds ?? []), row.cause];
    if (row.cause === "human_typed") facts.humanTurnCount = row.turnStarts;
  }
}

function addSignals(db: Db, ids: string, contexts: Map<string, SessionContext>): void {
  const sql = `SELECT DISTINCT session_id AS sessionId, signal FROM session_signal WHERE ${IN_SESSIONS}`;
  for (const row of db.prepare(sql).all({ ids }) as { sessionId: string; signal: string }[]) {
    const facts = contexts.get(row.sessionId)!.facts;
    facts.signalKinds = [...(facts.signalKinds ?? []), row.signal];
  }
}

function addTaskInitiatives(db: Db, ids: string, contexts: Map<string, SessionContext>): void {
  const sql = `
    SELECT substr(e.source_ref, 9) AS sessionId, t.initiative, COUNT(*) AS edges
    FROM "${KIT.edge}" e JOIN task t ON t.task_ref = e.target_ref
    WHERE e.relation = 'ran' AND e.t_expired IS NULL AND t.initiative IS NOT NULL
      AND e.source_ref IN (SELECT 'session:' || value FROM json_each(@ids))
    GROUP BY e.source_ref, t.initiative`;
  for (const row of db.prepare(sql).all({ ids }) as ({ sessionId: string } & TaskInitiative)[]) {
    contexts.get(row.sessionId)!.tasks.push({ initiative: row.initiative, edges: row.edges });
  }
}

function addLifetimes(db: Db, ids: string, contexts: Map<string, SessionContext>): void {
  const sql = `SELECT session_id AS sessionId, MIN(ts) AS first, MAX(ts) AS last FROM request_dedup WHERE ${IN_SESSIONS} AND is_sidechain = 0 GROUP BY session_id`;
  for (const row of db.prepare(sql).all({ ids }) as { sessionId: string; first: string; last: string }[]) {
    contexts.get(row.sessionId)!.lifetimeMs = Date.parse(row.last) - Date.parse(row.first);
  }
}

function addEpisodes(db: Db, ids: string, contexts: Map<string, SessionContext>): void {
  const sql = `SELECT session_id AS sessionId, heuristic, opened_by AS openedBy FROM "${EPISODE_TABLE}" WHERE ${IN_SESSIONS} ORDER BY session_id, heuristic, episode_index`;
  for (const { sessionId, ...episode } of db.prepare(sql).all({ ids }) as ({ sessionId: string } & StoredEpisode)[]) {
    contexts.get(sessionId)!.episodes.push(episode);
  }
}
