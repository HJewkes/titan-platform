---
"@titan-design/factory": patch
---

`shepherd status` marks a run stalled when it is held `g10-review` and no reviewer MERGE is recorded at its head, once it has waited more than 60 minutes in its merge step or in `sh-held-wait`. Only that MERGE releases such a hold, so before this change the run waited silently with no end. Owner holds, other hold classes, and holds satisfied at the head still have no limit.
