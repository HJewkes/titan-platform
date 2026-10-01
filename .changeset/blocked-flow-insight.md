---
"@titan-design/session-analytics": minor
"@titan-design/session-miner": minor
---

`blockedFlowReport` reports, per repo, the minutes from a reviewer's first `Verdict: MERGE` at a PR's final head to its merge, with still-open PRs as censored ages and an optional split at a moment such as a merge-authority grant. It also lists open PRs holding MERGE at their current head, counts classifier denials by reason and by the action refused, and counts idle implementer slot-minutes by the seat journal's stated reason. New exports: `parseVerdict`, `mergeOutcomes`, `latencyStats`, `parseDenials`, `classifyDeniedAction`, `parseSeatJournal`, `idleSlotMinutes`, `blockedFlowSchema`, `renderBlockedFlowText`, `BLOCKED_FLOW_SOURCES`.

`titan-miner insights blocked-flow` (Q7) runs it over agent-chat's events table (`TITAN_MINER_EVENTS_DB`), GitHub REST and the seat transcripts and journals given with `--transcript` and `--journal`. An insight's `answer` may now be async and receives the miner config.
