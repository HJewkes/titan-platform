---
"@titan-design/review-panel": minor
"@titan-design/factory": patch
---

TP-3638: the reviewer brief says "fix-proof waived by owner" when the owner's waive-proof names the head under review. `ReviewerBriefInput.fixProofWaivedAt` replaces the fix-proof reading (and the tests member's) only when it equals the head; a waiver at any other head leaves the brief unchanged. Shepherd's review phase passes the waived head to `sh-review`.
