---
"@titan-design/workflow": minor
---

`AssistedOptions.recordCancel`: a gate cancelled while the step waits on it becomes the step's recorded answer, with signal `GATE_CANCELLED_SIGNAL` (`gate-cancelled`) and data `{ reason }`, instead of throwing `GateCancelled`. The next call to the same step opens a fresh gate, and a replay reads the same cancel. Without the option a cancelled gate still fails the run, and cancelling the run still ends it.
