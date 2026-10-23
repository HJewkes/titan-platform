---
"@titan-design/fix-proof": patch
---

Leave a self-contained carried test out of `mutants.uncovered` (TP-4075). A changed test is exempt when it matches the `carry` globs and its runtime imports reach only carried files, Node builtins and vitest, following imports through every carried file they reach. No mutation may target a carried file, so no spec could cover such a test, and a test-only PR touching one could never reach `killed`. A carried test that loads non-carried source, directly or through a carried helper, still needs a spec, as does any test outside the carry paths.
