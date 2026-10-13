---
"@titan-design/github": minor
---

checks.ts is the one check-judging core: export `isSucceeded` (moved from readiness) and `isPassingConclusion`. `latestPerName` now treats an unstarted run (null `startedAt`) as newest, so a queued rerun shadows an older result and reads pending; a tie still goes to the higher id.
