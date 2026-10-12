---
"@titan-design/workflow": patch
---

`hydrate` no longer re-claims a run this runtime parked as `recovery_required` because its workflow returned with a step unfinished; it stays held until the row changes or a new runtime starts (TP-2438).
