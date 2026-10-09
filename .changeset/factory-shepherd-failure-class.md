---
"@titan-design/factory": minor
---

A failed Shepherd run's `workflow_run.error` now starts with a closed failure class, `[ci-timeout]`, `[gh-api-5xx]`, `[land-rules]`, `[update-branch]` or `[other]`, added at the `shepherd-pr` workflow boundary (TP-2091). `titan-factory shepherd stats --failures [--json]` counts failed runs by class per repo and ISO week, and classifies older unprefixed rows from their text with the same `failureClassOf`.
