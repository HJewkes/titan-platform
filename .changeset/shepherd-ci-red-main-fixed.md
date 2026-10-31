---
"@titan-design/factory": patch
---

Shepherd merges main up for a ci-red head whose red came with a stale merge ref (TP-4650). If none of the head's failing checks passed on the base commit its CI ran against, and a later base commit is green on them and on every required context, the base-red decision holds the head as a stale base red. Update-branch then merges main up, with no fixer woken and no repair spent. Previously the fixer was woken, could not merge main, and the run parked at await-new-head until a seat stepped in.
