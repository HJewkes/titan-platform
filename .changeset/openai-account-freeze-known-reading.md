---
"@titan-design/openai-account": patch
---

Deeply freeze the reading returned by `knownObservation` (the reading, `rate_limits`, `five_hour` and `seven_day`) so a later mutation cannot change a `quotaAdmission` answer.
