---
"@titan-design/owner-queue": minor
---

Read who answered a round from its feedback (TP-6773). `answeredFromFeedback` credits `feedbackAnswerer(general)`: the by-rec automation when `general` carries the new `BY_REC_FEEDBACK_GENERAL` mark, else `ROUND_ANSWERER`. `recheck` lets only the owner's own answer settle another item, and `consolidate`'s `shipBlockedBy` counts only the owner's answers, so an automation answer can neither drop a queued item nor replace an owner's change request. `isOwnerAnswer` is exported and takes any value with a `by`, so a reader that acts as the owner can refuse `{ by: feedbackAnswerer(general) }`.
