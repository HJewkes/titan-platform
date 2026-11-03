---
"@titan-design/factory": patch
---

Shepherd now holds `g10-adversary` a pull request that edits its sign-off, fix-proof, proof-waiver or merge-standing code (TP-4746): `SIGNOFF_POLICY_FILES` in `g10-class-rules.ts`, plus `packages/fix-proof/src/**` and `packages/review-panel/src/**`. Every Shepherd module those and the rest of the listed table import, value or type-only, is held too, through `g10-hold-closure.json`. `g10-hold-closure.test.ts` walks the imports from every listed module to a fixpoint and fails when a reached module is unheld or the list is stale. Test files stay exempt.
