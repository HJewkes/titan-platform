---
"@titan-design/factory": minor
---

Shepherd releases a `--reviewer` hold when that reviewer's newest verdict at the merge sha is MERGE. The hold check reads the named reviewer's latest session, refuses one in the implementer's lineage, and records the satisfaction with a compare-and-swap (migration 11). A new hold or a release clears it, `shepherd status` and `timeline` show it, and `sh-cleanup` releases the hold once the PR has landed.
