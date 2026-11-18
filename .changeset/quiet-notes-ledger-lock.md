---
"@titan-design/factory": patch
---

`shepherd visual-feedback-notes` now takes a lock in the state dir, so a second sweep started while one runs exits 75 instead of filing the same notes again. Each note's key is written to the ledger before `active-work task add` runs and taken back if the add fails, so a failed ledger write no longer leads the next sweep to file the note a second time (TP-5483).
