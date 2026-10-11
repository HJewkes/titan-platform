---
"@titan-design/factory": patch
---

A `g10-adversary` hold the seat released is re-held when the PR's head then moves to anything but a clean merge-up of the released head (a fix round, a fixer's push, or a merge-up whose conflicts were resolved by hand). Shepherd records a hold event naming the old and new head and tells the seat; a head whose tree equals the merge-tree of its parents stays released. `shepherd release` now records the head it released at.
