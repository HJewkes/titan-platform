---
"@titan-design/owner-queue": minor
---

Depend on `@titan-design/review-schema` ^0.3.0. `fromRoundQuestions`, `answeredFromFeedback` and `FeedbackInput` now take review-schema 0.3's round@2 manifest and feedback@1 shapes, so a round or feedback that only 0.3 knows becomes queue items instead of failing to parse.
