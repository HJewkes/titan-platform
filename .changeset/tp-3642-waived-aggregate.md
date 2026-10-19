---
"@titan-design/review-panel": minor
"@titan-design/factory": patch
---

TP-3642: the panel aggregate honours the owner's fix-proof waiver. `AggregateInput.fixProofWaivedAt` keeps a vacuous, missing or failed fix-proof from making the tests member blocking, or from counting an unplanned tests member as missing, only when it equals the head; a waiver at any other head changes nothing. `reviewPullRequest` and Shepherd's sh-review-panel step pass it through.
