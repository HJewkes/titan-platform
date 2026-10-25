---
"@titan-design/review-panel": minor
"@titan-design/factory": patch
---

`fixProofNeedsTests` is exported: the predicate `aggregate` uses to make the tests seat blocking. Shepherd's review intent plans a blocking tests member whenever it holds, so an `unproven` or `error` fix-proof on a panel with no tests member is reviewed by one instead of ending every round as no-verdict (TP-4195). A panel that still meets the unplanned seat (an intent recorded before this change) says so in its no-verdict reason, and the diagnosis brief no longer claims no reviewer was dispatched when every one answered.
