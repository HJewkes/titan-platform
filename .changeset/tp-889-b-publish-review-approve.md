---
"@titan-design/factory": patch
---

`sh-publish-review` now keeps Shepherd's APPROVE pull request reviews in line with the `shepherd/review` check it posts, under the `shepherd.reviewCheck` App. On a success it approves at the published head, reusing its own marked approval already there so a replay posts no second one. Every other Shepherd approval is dismissed on every publish, so a later FIX_FIRST, moved head or hold takes the approval back, even at the same head. People's reviews and other bots' unmarked reviews are left alone. A failed read, post or dismissal, or no configured App on a success, is recorded as `review.reviewError` and never fails the step. The step result carries `review.approved` and `review.dismissed`.
