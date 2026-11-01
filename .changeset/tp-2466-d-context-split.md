---
"@titan-design/factory": patch
---

Move `FactoryContext`, `GateSummary` and `NeedsSources` into a `context.ts` leaf and `resolveCommand` into `resolve-command.ts`, and add an import-cycle ratchet test. Types and one pure function only; no behaviour change.
