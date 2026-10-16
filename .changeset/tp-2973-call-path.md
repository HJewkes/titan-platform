---
"@titan-design/code-graph": minor
---

Add a call-path query (`findCallPath`, `snapshotCallPath`): the shortest directed path between two nodes, id-smallest among equal lengths. `projectCallPath` folds a path to a coarser level through a caller-supplied box mapping, and each hop names the level edge it rides (TP-2973).
