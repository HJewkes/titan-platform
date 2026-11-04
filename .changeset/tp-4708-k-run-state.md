---
"@titan-design/factory": patch
---

Move the Shepherd run records (`PrTarget`, `OrderRun` and kin) into a `run-state.ts` leaf and the carry kinds into a `carry-kinds.ts` leaf, drop the redundant `target` field on `ShepherdRun`, and lower the import-cycle ceiling to 19. A pure move; no behaviour change.
