import type { SessionGraph } from "./graph.js";

const BATCH = 400;

/**
 * Turn aggregates that no single line can supply. Contract: recompute, never
 * accumulate. Every value is a pure function of the fact rows, so incremental
 * refreshes and full rebuilds converge regardless of chunk boundaries.
 */
const ROLLUP = `
  WITH ordered AS (
    SELECT fact_id, session_id, event_type, ts, prompt_id,
      COUNT(CASE WHEN event_type = 'user_prompt' THEN 1 END) OVER (
        PARTITION BY session_id ORDER BY ts, transcript_id, seq ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS turn_no,
      LAG(event_type) OVER (PARTITION BY session_id ORDER BY ts, transcript_id, seq) AS prev_type,
      LAG(ts) OVER (PARTITION BY session_id ORDER BY ts, transcript_id, seq) AS prev_ts
    FROM fact WHERE session_id IN (SELECT value FROM json_each(@sessionIds))
  ),
  owners AS (SELECT session_id, turn_no, prompt_id FROM ordered WHERE event_type = 'user_prompt'),
  agg AS (
    SELECT owners.prompt_id AS prompt_id, MAX(ordered.ts) AS ended_at,
      CAST(ROUND((julianday(MAX(ordered.ts)) - julianday(MIN(ordered.ts))) * 86400000) AS INTEGER) AS duration_ms,
      SUM(CASE WHEN ordered.event_type = 'tool_decision' THEN 1 ELSE 0 END) AS tool_call_count,
      CAST(COALESCE(SUM(CASE
        WHEN ordered.event_type IN ('assistant_response', 'tool_decision') AND ordered.prev_type IN ('user_prompt', 'tool_result', 'tool_result_error')
        THEN ROUND((julianday(ordered.ts) - julianday(ordered.prev_ts)) * 86400000) END), 0) AS INTEGER) AS thinking_ms
    FROM ordered JOIN owners ON owners.session_id = ordered.session_id AND owners.turn_no = ordered.turn_no
    GROUP BY owners.prompt_id
  )
  UPDATE turn SET ended_at = agg.ended_at, duration_ms = COALESCE(agg.duration_ms, 0),
    tool_call_count = agg.tool_call_count, thinking_ms = COALESCE(agg.thinking_ms, 0)
  FROM agg WHERE turn.prompt_id = agg.prompt_id`;

/** `turn_index` is insert-order at write time; recomputing it from `started_at` makes it a property of the corpus. */
const RENUMBER_TURNS = `
  WITH ordered AS (
    SELECT prompt_id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY started_at, prompt_id) - 1 AS idx
    FROM turn WHERE session_id IN (SELECT value FROM json_each(@sessionIds))
  )
  UPDATE turn SET turn_index = ordered.idx FROM ordered WHERE turn.prompt_id = ordered.prompt_id`;

/** Recompute turn aggregates for the given sessions in one transaction. */
export function rollupSessions(graph: SessionGraph, sessionIds: readonly string[]): number {
  const unique = [...new Set(sessionIds)];
  if (unique.length === 0) return 0;
  const aggregate = graph.db.prepare(ROLLUP);
  const renumber = graph.db.prepare(RENUMBER_TURNS);
  return graph.db.transaction(() => {
    let updated = 0;
    for (let i = 0; i < unique.length; i += BATCH) {
      const batch = JSON.stringify(unique.slice(i, i + BATCH));
      renumber.run({ sessionIds: batch });
      updated += aggregate.run({ sessionIds: batch }).changes;
    }
    return updated;
  })();
}

/** A merge sighting and the `pr-link` naming the same PR routinely live in different transcripts; fold at pass end. */
const RECONCILE_PR_MERGES = `
  UPDATE pr SET state = 'merged',
    merged_at = (SELECT MIN(o.merged_at) FROM pr_merge_observation o WHERE o.number = pr.number AND (o.repo_hint IS NULL OR pr.repo LIKE '%/' || o.repo_hint))
  WHERE EXISTS (SELECT 1 FROM pr_merge_observation o WHERE o.number = pr.number AND (o.repo_hint IS NULL OR pr.repo LIKE '%/' || o.repo_hint))`;

/** Both halves of a `gh pr create` make a real PR whether or not a `pr-link` ever mentioned it. */
const RECONCILE_PR_CREATES = `
  INSERT INTO pr (pr_ref, number, repo, title, url)
  SELECT 'pr:' || repo || '#' || number, number, repo, title, url FROM pr_create_observation
  WHERE number IS NOT NULL AND repo IS NOT NULL AND title IS NOT NULL
  ON CONFLICT (pr_ref) DO UPDATE SET title = COALESCE(pr.title, excluded.title), url = COALESCE(pr.url, excluded.url)`;

/**
 * A subagent ends when its child session's last line does, not when the
 * dispatch's tool_result returns (most dispatches are async and return at
 * launch). Parentage comes from the dispatch that ran inside a child transcript.
 */
const RECONCILE_SUBAGENTS = `
  UPDATE subagent SET
    ended_at = COALESCE((SELECT s.ended_at FROM session s WHERE s.session_id = subagent.child_session_id), ended_at),
    parent_agent_ref = COALESCE((SELECT p.agent_ref FROM subagent p WHERE p.child_session_id = subagent.session_id), parent_agent_ref)`;

export interface ReconcileCounts {
  prMerges: number;
  prCreates: number;
  subagents: number;
}

/** Whole-table reconciliations, run once at the end of a refresh pass after the rollup. */
export function reconcile(graph: SessionGraph): ReconcileCounts {
  return {
    prCreates: graph.db.prepare(RECONCILE_PR_CREATES).run().changes,
    prMerges: graph.db.prepare(RECONCILE_PR_MERGES).run().changes,
    subagents: graph.db.prepare(RECONCILE_SUBAGENTS).run().changes,
  };
}
