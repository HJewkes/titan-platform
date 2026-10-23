---
"@titan-design/fix-proof": patch
---

Leave changed tests that match the `carry` globs out of `mutants.uncovered` (TP-4075). Such a test, for example one under `test-support/`, tests only carried helpers, which no mutation may target, so no spec could ever cover it and a test-only PR touching one could never reach `killed`. A changed test outside the carry paths still needs a spec of its own.
