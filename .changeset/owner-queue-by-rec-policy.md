---
"@titan-design/owner-queue": minor
---

Add `byRecDecision(subject, now, policy)`, the pure policy that says whether an owner approval with a recommendation resolves to it after a wait. Adds the `titan/auto-by-rec-policy@1` policy schema (mode off, shadow or live; `afterHours` 24 by default; exclusions that can only add to the in-code floor), `BY_REC_FLOOR` and `isGuardPath`, `byRecSubjectOfItem`, the `titan/auto-by-rec@1` log row schema and the `BY_REC_RESOLVER` attribution.
