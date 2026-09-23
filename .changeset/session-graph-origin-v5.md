---
"@titan-design/session-graph": minor
---

Add migration 5, "origin, episodes, prices": the `session_origin`, `session_external_event`, `episode` and `price` tables, plus the `request_dedup`, `request_cost` and `context_contribution` views. Every cost query should read `request_dedup`, never `request`, so fan-out copies of one request count once.

Add the `OriginResolver` seam. Pass `resolveOrigins` to `refreshCorpus` and, once per pass, it is asked about every session with no origin row or one older than the session's `ended_at`. Each resolved origin with a parent becomes a `spawned` edge and a `subagent` row (`agent:<originSystem>:<agentId>`), so existing subagent queries cover launcher-spawned workers. A resolver that throws is reported in `RefreshSummary.origins` and never fails the pass. `resetIndex` clears the origin tables and episodes; `purgeTranscript` drops a rewritten session's episodes.
