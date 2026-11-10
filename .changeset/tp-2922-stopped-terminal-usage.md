---
"@titan-design/workflow": patch
---

Tests now pin that a durable step whose harness stops after spending counts that spend once against a `mapItems` budget, for each of the aborted, wall_time_exceeded and cancelled_unknown stops, even when reconcile returns the same terminal again. Test only; no production code changes.
