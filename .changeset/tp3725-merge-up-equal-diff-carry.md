---
"@titan-design/factory": patch
---

Shepherd carries a reviewed MERGE across a merge-up whose first parent is an unreviewed merge-up when the PR's own diff is unchanged (TP-3725). The tree probe records `patchEqual`, a patch-id comparison of the new head's diff against its second parent with the reviewed head's diff against its merge base, and the carry scope records `g10Held`. Only `correctness`, `feature` and `refactor` runs never G10-held take the rule; security runs and G10-held runs re-review as before, and the carry records no `sh-merge-up` step.
