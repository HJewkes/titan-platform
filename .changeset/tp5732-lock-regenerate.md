---
"@titan-design/factory": patch
---

When `closure.lock.json` is a pull request's only merge conflict, Shepherd merges main and regenerates the lock itself instead of waking a fixer (TP-5732). The `sh-lock-regen` step text-merges the head onto main in Shepherd's git cache, checks the merge out, builds the factory and runs `registry:closure --write` on the merged tree with credentials stripped from the environment, then pushes the merge as a fast-forward. A conflict in any other file, a failed regeneration, a fork head or an advisory repo still wakes the fixer. Each attempt records its `conflicted` paths and outcome in the run's timeline.
