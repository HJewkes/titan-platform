---
"@titan-design/session-graph": minor
---

Store review verdicts parsed from agent-chat messages. Migration 8, `review verdicts` (exported as `REVIEW_VERDICT_MIGRATION_NAME`), adds the `pr_review` table (`REVIEW_TABLE`, `REVIEW_DDL`) and the `pr` columns `review_rounds_gh`, `review_rounds_chat` and `commit_times`; it copies `review_rounds` into `review_rounds_gh` and re-queues every PR for the outcome resolver once. `applyDelta` writes one chat row per `review_verdict` event, keyed `chat:<tool_use_id>:<n>`, holding only parsed fields; `purgeTranscript` and `resetIndex` clear them. `ResolvedPr` gains optional `commitTimes`, stored as a JSON array; an omitted field leaves the stored value. `prsNeedingOutcome` also offers a merged PR whose `commit_times` is null, ordered after never-checked and open PRs. A resolver's `reviewRounds` now also sets `review_rounds_gh`.
