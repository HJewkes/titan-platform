---
"@titan-design/fix-proof": patch
---

Leave a self-contained carried test out of `mutants.uncovered` (TP-4075). A changed test is exempt when it matches the `carry` globs and its runtime imports reach only carried files, vitest and builtins that cannot start a process, a worker or evaluated source. Imports are followed through every carried file they reach. No mutation may target a carried file, so a test-only PR touching such a test could otherwise never reach `killed`. A changed test still needs a spec if it loads non-carried source (directly or through a carried helper), another package, or `child_process`, `worker_threads` or `vm`, or if it runs code outside the import graph. So does any test outside the carry paths. The rule assumes a carried test reads files only to judge tests or carried files.
