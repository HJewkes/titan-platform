---
"@titan-design/factory": patch
"@titan-design/workflow": patch
---

TP-3107 S4: `FactoryHostOptions.markerShadow` wraps each workflow's guarded context in `shadowContext`, which reports a marker verdict before every fact step and appends its marker after the live call. It is off by default and serve does not set it, so `step_results` stays authoritative. Adds `titan-factory markers why <owner/repo#N> <fact>`, a read-only explanation of a fact's verdict, its inputs, drift and newest marker rows. `@titan-design/workflow` now exports `memoKey` and `CapabilityVault`.
