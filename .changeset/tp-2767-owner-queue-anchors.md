---
"@titan-design/owner-queue": minor
---

Items and options gain optional `anchors` and item `pins`; `writeDeposit(dir, deposit, { source })` refuses, unwritten, a deposit whose anchor is past EOF at its pinned commit (TP-2767).
