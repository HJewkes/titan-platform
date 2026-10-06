---
"@titan-design/cluster": patch
---

`DrainTree.insert` now reports the clusters it evicted in `MatchResult.evicted`, and `Clusterer` drops their template bindings, so `templateCount` and the snapshot's `templateIds` stay bounded by `maxClusters`. Loading an older snapshot prunes bindings for clusters it no longer holds. `isNewTemplate` now means no live cluster was bound to the id: a template whose cluster was evicted and recurs is reported new again, as it already was after a restore.
