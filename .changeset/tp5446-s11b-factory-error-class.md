---
"@titan-design/factory": patch
---

A failed Shepherd run records its failure class in `workflow_run.error_class`, set where it failed, so nothing classifies the error text afterwards. Each `ci-wait` timeout throws a `ShepherdFailure` carrying `ci-timeout`. Every land and Shepherd code route records the class of its own failure: a GitHub rate limit, `land-rules`, a GitHub server-side failure, `update-branch`, or `other`, ranked as before. gh-retry reads the recorded class. `shepherd stats --failures` reads it too, and falls back to the old text rules only for rows written before the column existed. Which failures are retried, and how, is unchanged.
