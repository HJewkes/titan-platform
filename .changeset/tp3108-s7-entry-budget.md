---
"@titan-design/factory": patch
---

The marker shadow counts each entry's replayed calls, fact evaluations and shadow time on the host's clock, stands down for the rest of an entry once `markerShadow.entryBudget` (default 200 evaluations / 2 s) is hit, and sends `budget-exceeded` and `entry-end` to the sink. An `Unavailable` step output writes no marker. The live replay is never stopped.
