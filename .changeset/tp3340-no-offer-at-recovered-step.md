---
"@titan-design/factory": patch
"@titan-design/workflow": patch
---

TP-3340: Shepherd opens no visual accept offer at a step the old host left in flight, so a flag turned on between hosts cannot end an adopted run short of that step. The workflow context gains `recoveredInFlight()`.
