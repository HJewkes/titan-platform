---
"@titan-design/hitl": patch
---

Derive `GateStatus` and the SQLite status trigger's status list from one `GATE_STATUSES` tuple, and explain the no-op rejection handler in `readDecision` (TP-1361). The trigger SQL is byte-identical.
