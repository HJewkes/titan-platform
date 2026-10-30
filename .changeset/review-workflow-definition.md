---
"@titan-design/review-workflow": minor
---

Add `reviewWorkflow`, the review recipe as a registrable `@titan-design/workflow` definition pinned to `REVIEW_WORKFLOW_VERSION`, with `reviewRoutes` (one inline code route per step body) and `reviewOutcomeOf`. Add `reviewRunner`, the standalone host: it registers the definition under its version, starts and awaits review runs, resumes an interrupted run from its record on `hydrate` with no second member spawn, parks a run pinned to another version as `recovery_required`, and on `resolve(fingerprint)` reviews every run parked on the fixer fingerprint again (TP-3926).
