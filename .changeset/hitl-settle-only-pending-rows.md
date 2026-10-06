---
"@titan-design/hitl": patch
---

Settle a gate with a conditional write, so a resolve, cancel or lazy expiry that loses a race to another store on the same file throws `GateAlreadySettled` (or `GateExpired`) instead of overwriting the first answer. `BaseGateStore.update` now returns whether the row was still pending; a custom subclass must return `false` when it was not.
