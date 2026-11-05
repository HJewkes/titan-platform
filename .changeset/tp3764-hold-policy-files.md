---
"@titan-design/factory": patch
---

Shepherd now holds `g10-adversary` a pull request that edits a Shepherd module importing the hold, the sign-off rule or the release (TP-3764): `await-pr.ts`, `coverage.ts`, `pr.ts` and `shepherd-steps.ts` join the listed sign-off table, and the import closure grows with them. A new test fails when a Shepherd module importing `registration-hold`, `signoffs` or `g10-release` is not held.
