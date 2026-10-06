---
"@titan-design/hitl": minor
---

Settle a gate with a conditional write, so a resolve, cancel or lazy expiry that loses a race to another store on the same file no longer overwrites the first answer. When the winner wrote the same answer (same status, payload and reason), the loser gets the settled gate back, so a retry still succeeds. A different answer throws `GateAlreadySettled` (or `GateExpired`).

Breaking for custom stores: `BaseGateStore.update` now returns a boolean. A subclass must write only while the stored row is still pending and return `false` when it was not.
