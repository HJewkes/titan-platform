---
"@titan-design/factory": patch
---

Shepherd's head-moved sweep also cancels, as superseded with condition `base-changed`, a pending approve-merge gate whose named base differs from the PR's live base, or whose base is not the default branch on a run without the feature-base grant (`supersedeRebasedGates`). A Shepherd merge decision whose MERGE evidence was read on another base than the one land just checked gates instead of allowing.
