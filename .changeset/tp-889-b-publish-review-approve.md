---
"@titan-design/factory": patch
---

`sh-publish-review` now also posts an APPROVE pull request review at the published head, under the `shepherd.reviewCheck` App, exactly when the `shepherd/review` check it posts is a success. It lists reviews first and reuses Shepherd's own marked approval at that head, so a replay posts no second one. A failed read or post, or no configured App, is recorded as `review.reviewError` and never fails the step; the step result carries `review.approved` with the review id.
