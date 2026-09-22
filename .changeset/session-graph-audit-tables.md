---
"@titan-design/session-graph": minor
---

Add migration 4, "audit tables", and write session-read's audit events into it (TP-265).

The migration creates `request`, `tool_call`, `inbound`, `context_block`, `compaction`, `queue_op`, `session_signal`, `cost_state_observation` and `transcript_facet`, and adds `session.account`, `turn.wake_cause`, `task.estimate`, `pr.review_rounds`, `pr.closed_at` and `pr.outcome_checked_at`. Each `ADD COLUMN` is guarded, so the migration also succeeds on a database that already has some of those columns.

`applyDelta` now writes the audit rows in the same transaction as everything else. It stores one `request` row per `(transcript_id, request_id)` with the smallest byte offset and timestamp and the largest value of each token column. It takes an optional fourth argument, `{ account }`, and `indexTranscript` passes the discovered transcript's account into `session.account`. `purgeTranscript` and `resetIndex` clear the new tables. `AUDIT_TABLES`, `FACET_TABLE` and `AUDIT_MIGRATION_NAME` are exported.

`session_signal`'s primary key is `(transcript_id, byte_offset, block_index, signal)`: a single tool block can emit more than one signal (for example a Bash block that both commits and pushes), and the signal name is what disambiguates those rows.
