---
"@titan-design/factory": patch
---

Shepherd now holds `g10-adversary` a pull request that edits its own sign-off, reviewer-pick, fix-proof or merge-standing code (TP-3764): `signoffs.ts`, `reviewer-lineage.ts`, `reviewer-roles.ts`, `auto-pass.ts`, `fix-proof.ts`, `merge-standing.ts` and the other Shepherd modules that import `g10-release`, `signoffs` or `registration-hold`, plus `packages/fix-proof/src/**`, `packages/review-panel/src/classify.ts` and `scripts/fix-proof-run.sh`. Test files stay exempt. A new test fails when a Shepherd module importing those three is not held.
