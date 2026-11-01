---
"@titan-design/factory": patch
---

Move the fix-proof waiver table, its migration and `ProofWaivers` into a `proof-waiver-table.ts` leaf, and `KindMove` into `task-kind.ts`, so the Shepherd store no longer imports the waiver routes or register-kind.ts, and lower the import-cycle ceiling. A pure move; no behaviour change.
