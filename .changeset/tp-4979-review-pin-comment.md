---
"@titan-design/github": patch
---

Correct the `CreateReviewRequest` doc comment: pinning `commitId` records the head an approval was given at, but GitHub still counts it after a later push unless branch protection dismisses stale approvals (TP-4979).
