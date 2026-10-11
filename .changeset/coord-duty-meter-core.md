---
"@titan-design/session-analytics": minor
---

Add the coordinator duty meter core. `mergeCopies` meters seat transcript lines into duty-classified, priced calls and turns, with copy dedupe, per-pool window starts, rebuilt triggers and outcomes, and the `TP1550_RULES` and `V3_RULES` rule sets. `dutyTable` totals them into the `titan.coord-duty/v1` duty table, and `seatOf` names a transcript's seat.
