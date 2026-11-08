---
"@titan-design/factory": patch
---

`sh-publish-review` now dismisses Shepherd's own stale approvals when it publishes a non-success `shepherd/review` check. It dismisses each bot review that is still APPROVED and carries the Shepherd marker, at any head including the published one, so a MERGE approval does not outlive a later unmet-attestation or FIX_FIRST publish at the same head; human reviews and other bots' reviews are left alone. The step result records `review.dismissed` with the ids. A failed list or dismissal, or no configured App, is recorded as `review.reviewError` and never fails the step.
