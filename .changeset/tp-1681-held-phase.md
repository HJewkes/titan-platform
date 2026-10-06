---
"@titan-design/factory": patch
---

A held Shepherd run now waits in its own `held` phase, naming the hold, with no stall limit, instead of reading as stalled in `merging`. A merge waiting at a head that a fix round replaced ends once the hold's reviewer sends MERGE at the new head.
