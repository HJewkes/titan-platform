---
"@titan-design/factory": patch
---

`sh-publish-review` now dismisses Shepherd's own stale approvals when it publishes a non-success `shepherd/review` check. It dismisses each bot review that is still APPROVED, carries the Shepherd marker and sits at a head other than the published one; human reviews and other bots' reviews are left alone. The step result records `review.dismissed` with the ids. A failed list or dismissal, or no configured App, is recorded as `review.reviewError` and never fails the step.
