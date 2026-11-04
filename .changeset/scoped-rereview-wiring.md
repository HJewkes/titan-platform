---
"@titan-design/factory": patch
---

Wire the scoped fix-round re-review behind `shepherd.review.scopedRereview` (TP-3735 S3), off when absent. Under `shadow` or `on`, a fix round after a reviewer's FIX_FIRST runs `sh-review-scope:<head>` and records `scoped` (and why not) on the `sh-review` result; under `on` the correctness brief reads the fix diff and the findings since the run's last MERGE. The first review, other causes, D8's convergence head and every other panel member stay full.
