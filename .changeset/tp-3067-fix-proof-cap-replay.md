---
"@titan-design/factory": patch
---

A run recorded before the fix-proof cap existed replays its fix-proof wakes without diverging (TP-3067): when the record goes on without an `sh-wake-fix-proof` step, the replay neither records one nor counts it, so strict replay no longer parks the run in recovery.
