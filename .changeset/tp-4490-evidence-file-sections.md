---
"@titan-design/factory": minor
---

`gate.ownerEvidence` now shows file sections (TP-4490, the second slice of TP-4404). The paths come from the evidence's own `merge.changedPaths`: `.github/` files for a CI-policy fact, repo skill files for `skill-path`. Both sides of each path are read by blob sha against the merge base. A file reaches the card only when both sides decode to their blob's bytes, the head matches the evidence's `headBlobs` pin, the blobs differ, and the shown rows (through the new reversible `exactLine`) rebuild the head bytes from the base. Otherwise it reads `missing`. A `files-unread` gate always reads `missing`.
