---
"@titan-design/session-graph": minor
---

Add the audit rollup and recompute `session_model_usage` from the `request` table (TP-266).

`rollupSessions` now fills the rollup-owned audit columns for touched sessions, in the same transaction and batch loop as the turn rollup: `request.seq_in_session`, `gap_ms`, `ctx_delta` and the `wake_*` columns, `inbound.queued_ms`, `compaction.mid_loop` and `turn.wake_cause`.

**Behaviour change: usage totals roughly halve.** `applyDelta` no longer accumulates usage line by line. One API response is written as several assistant lines, and each line used to add its usage again, so token counts and `request_count` were inflated. `session_model_usage` is now recomputed from `request`, which holds one row per request ID. Sessions with no request rows, such as those whose transcripts are gone, keep their old rows until they are re-indexed.
