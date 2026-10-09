---
"@titan-design/factory": patch
---

Carry a reviewed MERGE across a clean merge-up of main and release a `g10-review` hold at the new head. A tree-equal carry now needs the new head's first parent to be the reviewed head, its second parent on the base branch and its tree the clean merge-tree of the two; the run log records it as an `sh-merge-up` step, and `sh-g10-release` releases on the reviewed head's opus MERGE once checks are green at the new head. A `g10-adversary` hold still waits for the seat.
