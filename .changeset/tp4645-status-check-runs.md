---
"@titan-design/github": minor
---

Adds `statusCheckRuns(statuses, sha, contexts)`, which stands each named commit-status context in as a GitHub Actions check run so the check-run judges count CI that posts a status: `success` passes, `pending` is running, any other state is red, and a context with no status is a queued run (TP-4645).
