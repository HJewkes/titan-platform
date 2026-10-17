---
"titan-console": patch
---

The console reads feedback.json with a strict copy of review-schema 0.3.0's `FeedbackSchema`, so an answer that `rounds.submit` marked `recommendationSeen`, or that carries option notes, stays answered in the approvals queue and imports (TP-3272). Feedback with a blind-ab answer is refused. Owner-queue is given 0.3 feedback with only the keys 0.3 added removed. If that projected feedback still fails 0.1, the round is reported as a gap and its questions are not opened again.
