---
"@titan-design/factory": patch
---

TP-4978: the merge train takes its clock as an argument instead of defaulting to `Date.now`; `mergeTrainRef`, `MergeTrain` and `rideTrain` now require it, and the host passes its own. `shepherd/train.ts` leaves the recipe capability baseline. No step id, order or recorded input changes.
