---
"@titan-design/github": minor
---

checks.ts is the one check-judging core: export `isSucceeded` (moved from readiness) and `isPassingConclusion`. `latestPerName` now treats a run with no `startedAt` that has not completed as newest, so a queued rerun shadows an older result and reads pending; a completed run with no start, like an equal start, orders by the higher id.
