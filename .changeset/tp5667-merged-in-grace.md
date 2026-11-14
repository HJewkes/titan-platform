---
"@titan-design/factory": patch
---

Count a lane merge inside the 20-minute deploy grace as merged-not-deployed (TP-5667). The deploy block now carries `waitingSince`, the time of the oldest ask or origin/main commit the running build lacks, and the dispatcher cuts off at that instead of waiting for a commit to age past the grace.
