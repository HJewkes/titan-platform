---
"@titan-design/decider": minor
---

Principles on `@titan-design/memory`: `principleBullet` (category is the domain, provenance is `ledger:<key>`), `feedbackForRow` and `applyFeedback` (owner answers become helpful or harmful feedback once per ledger key; decider answers, unclaimed and unparsed rows are skipped; overrules penalise the cited principles), `writePrincipleDocs` (one versioned markdown doc per domain with examples, counter-examples, confidence, last confirmed and changelog) and the frozen `ALWAYS_ASK` list with `alwaysAskList(hardStops)`.
