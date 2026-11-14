---
"@titan-design/factory": patch
---

When `closure.lock.json` is a pull request's only merge conflict, Shepherd merges main and regenerates the lock itself instead of waking a fixer (TP-5732). The `sh-lock-regen` step text-merges the head onto main in Shepherd's git cache, exports the merge as a tar and builds the factory and runs `registry:closure --write` on it inside a bwrap sandbox with no host home, git directory, credential or environment, and the network only for the install. Shepherd writes the tree itself with only the lock swapped, refuses one that differs from the merge elsewhere, and pushes the merge as a fast-forward. A conflict in any other file, a failed regeneration, a fork head, a head branch that is the default branch (or a default branch GitHub cannot report) or an advisory repo still wakes the fixer. Each attempt records its `conflicted` paths and outcome in the run's timeline.
