---
"@titan-design/workflow": patch
---

`ctx.authorize` now refuses a gate already recorded at the step's id under a different rule than the request's action maps to, instead of resuming it. The resolution is still judged against the recorded rule.
