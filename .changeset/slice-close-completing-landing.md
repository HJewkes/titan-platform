---
"@titan-design/factory": patch
---

Shepherd keep mode now closes a task on a slice only when that landing completes its slice list (TP-4714). A task left open after every slice landed stays open on a later slice PR and notes why; `--last-slice` still closes it, now with or without `--slice`. A new task tag `hold:<reason>` holds against every merge. A notes re-plan sharing a heading's labels extends the heading list, and a bare label after a word other than "slice", as in "Phase 2 moved to TP-9", is no longer a moved slice.
