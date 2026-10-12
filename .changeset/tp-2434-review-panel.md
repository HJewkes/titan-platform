---
"@titan-design/review-panel": minor
---

An `error` fix-proof verdict is blocking: the tests brief says so and `aggregate` makes the tests member block on it. `reviewerBrief` takes `fixProofUnverified` (`error`, `untrusted` or `unread`) and adds a closed-map section telling the reviewer the proof is blocking unless an added test is shown failing on the base (TP-2434 a).
