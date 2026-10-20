---
"@titan-design/factory": patch
---

Shepherd no longer asks the owner about a failed fallback reviewer or a surviving conflict (TP-3734 r3). A fallback reviewer that fails on infrastructure too records `D7/ops-notice` and tells the hub seat, naming the failed outcomes and the reviewer account; a seat-held run-out tells the seat (`D7/seat-notice`). A conflict that survives the implementer's fixer wakes one fresh fixer, then tells the seat. Each run then waits for a new head. `GATE_DEMOTIONS.failedFallback` and `GATE_DEMOTIONS.conflict` revert each one.
