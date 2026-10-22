---
"@titan-design/autoresearch": minor
---

Read concurrent winners, snapshots and syncs in the run read model. Each `ArRoundView` gains `moves` and `reevals`, and `ArRunView` gains `snapshots`, `snapshotPending` and `syncs`, all replayed from the recorded steps. `ArRunSummary` gains `openSnapshot`. A sync's B re-measure appears under that sync's `runs`, never in an idea's ladder. A run recorded before these steps reads with every new section empty.
