---
"@titan-design/workflow": patch
---

`WorkflowRuntime.shutdown()` now stops admission: `hydrate()` returns nothing and `start()` leaves its row unclaimed afterwards, and a hydrate still reconciling when shutdown lands releases the run instead of launching it. `quiesced()` still reports only `quiesce()`.
