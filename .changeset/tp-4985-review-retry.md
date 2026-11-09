---
"@titan-design/factory": patch
---

`sh-publish-review` retries a review list or dismissal that fails on a GitHub server error or a short rate limit, with a bounded backoff on an injected clock and sleep (TP-4985). A failure that outlasts the retries stays in `review.reviewError` and now shows in the seat digest as an open item while it is the newest publish at the head. Shepherd's own approvals are matched by the review App's login (`shepherd.reviewCheck.login`) as well as the marker, so another account's review carrying the marker is never dismissed or reused (TP-4979).
