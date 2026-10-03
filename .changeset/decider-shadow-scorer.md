---
"@titan-design/decider": minor
---

Add the shadow scorer: `score(predictions, ledger, { policy, now })` reports per-category agreement, missed redirects and the accept baseline, recommends `auto` when a category clears its graduation thresholds, and flags demotion on 2 overrules in 7 days; `applyDemotions` drops those categories back to shadow.
