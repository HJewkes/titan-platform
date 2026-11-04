---
"@titan-design/factory": patch
"@titan-design/workflow": patch
---

TP-3107 S4a: `FactoryHostOptions.markerShadow` wraps each workflow's guarded context in `shadowContext`. Before every fact step it reports a marker verdict, and after the live call it appends the step's marker. It is off by default and serve does not set it, so `step_results` stays authoritative. `@titan-design/workflow` now exports `memoKey` and `CapabilityVault`.
