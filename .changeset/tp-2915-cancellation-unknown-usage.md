---
"@titan-design/workflow": patch
"@titan-design/factory": patch
---

A durable step that ends with cancellation unknown now keeps the spend its harness reported. `DurableStepOutcome`'s `cancellation_unknown` gains `usage?`, and the parked try holds it as `unsettledUsage` on its active step. Reconcile answers the parked try with the same terminal again, so that report replaces the earlier one instead of adding to it. The spend is charged once: to the retry that replaces the try after a retry-safe restart, or to the answer `completeStep` records.
