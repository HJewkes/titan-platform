---
"@titan-design/factory": patch
---

Shepherd no longer leaves an authority/MRG-AU approve-merge gate pending on a stale head or a transient merge-tree read. `shepherd resync` and the periodic head sweep cancel a pending MRG-AU gate whose head is no longer the pull request's head, and `shepherd resync` also cancels one still at the head whose only unmet condition was `merge-tree-clean`. The run then starts a new cycle at the current head and reviews it again, so its facts are read afresh. The gate is only ever cancelled, never resolved, so the owner stays its only resolver. Release, guard and route gates, and any rule other than authority/MRG-AU, are left alone; a seat or registration owner-gate gate is still superseded only when its head moves, as before. `shepherd resync` prints one line per superseded gate naming the run, the old and new head and the condition.
