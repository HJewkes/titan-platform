---
"@titan-design/factory": patch
---

Add the Shepherd phases contract (`ShepherdPhases`, `WakeRequest`, `WakeOutcome`, `Verdict`) with wake and review stubs. The stubs declare no steps, wake reports `unhandled`, and review returns `none`, so the owner gate keeps deciding until the real phases land (TP-484).
