import { prepareAuditRollup } from "./audit-rollup.js";
import { SIGNAL_COPY_RANK } from "./audit-schema.js";
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

const IN_SHARED = "session_id IN (SELECT session_id FROM shared)";

/**
 * `session`'s counters accumulate per transcript at write time, so a session found in two
 * transcripts (a mirror from another host, a resume that copied its history) counts every
 * shared line twice. Those sessions are recounted from their children instead: an assistant
 * line counts once however many files hold a verbatim copy, and a commit or push once per
 * first signal copy. A session in one transcript keeps its accumulated counts, which are exact
 * and do not depend on its audit facet being current — unless `@minCopies` is 1, which purge
 * passes for a session it handed off: those counts still hold the purged copy's lines.
 */
const RECOUNT_SHARED_SESSIONS = `
  WITH shared AS (
    SELECT session_id FROM fact WHERE session_id IN (SELECT value FROM json_each(@sessionIds))
    GROUP BY session_id HAVING COUNT(DISTINCT transcript_id) >= @minCopies
  ),
  per_file AS (
    SELECT session_id, event_type, ts, byte_length, tool_use_id, COUNT(*) AS n FROM fact
    WHERE ${IN_SHARED} AND event_type IN ('assistant_response', 'tool_decision')
    GROUP BY session_id, transcript_id, event_type, ts, byte_length, tool_use_id
  ),
  lines AS (
    SELECT session_id, SUM(copies) AS n FROM (
      SELECT session_id, MAX(n) AS copies FROM per_file GROUP BY session_id, event_type, ts, byte_length, tool_use_id)
    GROUP BY session_id
  ),
  signals AS (
    SELECT session_id, SUM(signal = 'commit') AS commits, SUM(signal = 'push') AS pushes FROM (
      SELECT session_id, signal, ${SIGNAL_COPY_RANK} AS copy_rank FROM session_signal
      WHERE ${IN_SHARED} AND signal IN ('commit', 'push'))
    WHERE copy_rank = 1 GROUP BY session_id
  )
  UPDATE session SET
    turn_count   = COALESCE((SELECT n FROM lines WHERE lines.session_id = session.session_id), 0),
    commit_count = COALESCE((SELECT commits FROM signals WHERE signals.session_id = session.session_id), 0),
    push_count   = COALESCE((SELECT pushes FROM signals WHERE signals.session_id = session.session_id), 0)
  WHERE ${IN_SHARED}`;

/** Recompute turn aggregates, shared-session counters and the audit rollup for the given sessions in one transaction. */
export function rollupSessions(graph: SessionGraph, sessionIds: readonly string[]): number {
  const unique = [...new Set(sessionIds)];
  if (unique.length === 0) return 0;
  const aggregate = graph.db.prepare(ROLLUP);
  const renumber = graph.db.prepare(RENUMBER_TURNS);
  const recount = graph.db.prepare(RECOUNT_SHARED_SESSIONS);
  const audit = prepareAuditRollup(graph.db);
  return graph.db.transaction(() => {
    let updated = 0;
    for (let i = 0; i < unique.length; i += BATCH) {
      const batch = JSON.stringify(unique.slice(i, i + BATCH));
      renumber.run({ sessionIds: batch });
      updated += aggregate.run({ sessionIds: batch }).changes;
      recount.run({ sessionIds: batch, minCopies: 2 });
      audit(batch);
    }
    return updated;
  })();
}

/** Recount `session`'s counters from the facts of every transcript still holding these sessions, even a single one. */
export function recountSessions(graph: SessionGraph, sessionIds: readonly string[]): void {
  if (sessionIds.length === 0) return;
  graph.db.prepare(RECOUNT_SHARED_SESSIONS).run({ sessionIds: JSON.stringify(sessionIds), minCopies: 1 });
}

/**
 * A merge sighting and the `pr-link` naming the same PR routinely live in different transcripts; fold at pass end.
 * Once the forge has checked a PR (`outcome_checked_at` set), its `merged_at` is forge-accurate and must not be
 * overwritten by a transcript sighting time on a later pass.
 */
const RECONCILE_PR_MERGES = `
  UPDATE pr SET state = 'merged',
    merged_at = (SELECT MIN(o.merged_at) FROM pr_merge_observation o WHERE o.number = pr.number AND (o.repo_hint IS NULL OR pr.repo LIKE '%/' || o.repo_hint))
  WHERE pr.outcome_checked_at IS NULL
    AND EXISTS (SELECT 1 FROM pr_merge_observation o WHERE o.number = pr.number AND (o.repo_hint IS NULL OR pr.repo LIKE '%/' || o.repo_hint))`;

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
