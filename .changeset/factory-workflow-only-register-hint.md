---
"@titan-design/factory": patch
---

`shepherd register` hints at `--kind feature` or `refactor` when a fix-proof kind is registered on a workflow-only diff, because a workflow-ci fix-proof is NO_REPRO unless a required check is red at the merge base and the kind cannot leave the fix-proof kinds later.
