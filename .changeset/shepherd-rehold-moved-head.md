---
"@titan-design/factory": patch
---

A `g10-adversary` hold the seat released is re-held when the PR's head then moves to anything but a clean merge-up of the released head (a fix round, a fixer's push, or a merge-up whose conflicts were resolved by hand). Shepherd records a hold event naming the old and new head and tells the seat; a head whose tree equals the merge-tree of its parents stays released. `shepherd release` now requires `--head <sha>`, the head the seat reviewed, refuses it when the PR is at another head or the head cannot be read, and records it. A re-hold is written by a compare-and-swap, so a hold or release made while the probe runs is never overwritten. The merge check enforces the rule too, so a head no CI read saw (a hold of another class released after the last read) is refused and re-held at the merge. `shepherd release` refuses a run that is not held.
