---
"@titan-design/factory": patch
---

The Shepherd merge guard no longer holds a run whose merge-order wait hit the merging stall limit behind a reservation whose holder is only reviewing its resolved head (TP-4569). Such a holder is in the TP-4497 review round: it has pushed past the head it reserved at and is not yet in its merge step. A run that never waited out its turn is still held as before.
