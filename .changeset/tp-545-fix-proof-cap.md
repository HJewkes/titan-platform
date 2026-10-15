---
"@titan-design/factory": patch
---

Shepherd caps fix-proof bounces at two wakes per run (TP-545 b): each fix-proof wake records an `sh-wake-fix-proof` step before it is asked, and the third returns unhandled so the owner gate decides.
