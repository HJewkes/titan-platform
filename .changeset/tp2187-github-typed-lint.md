---
"@titan-design/github": patch
---

Typed-lint burn-down (TP-2187): the package source and tests no longer rely on unsafe type assertions. `getBranchProtected` now types the branch answer as possibly empty, which matches the runtime guard it already had. No behaviour change.
