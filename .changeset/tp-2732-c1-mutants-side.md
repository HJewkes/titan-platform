---
"@titan-design/fix-proof": minor
---

Add the mutation check's exec side (TP-2732 c1). `fix-proof exec --side mutants` (`execMutants`) builds the merge base, overlays the head's tests, runs a baseline, then applies each declared mutation alone, rebuilds the package that owns its file, reruns the spec's test file and restores it, writing one `mutants.report`. With `--sandbox-user`, every build and vitest call after the overlay runs in the sandbox. `fix-proof judge --mutants-report <file>` reads that report into the result line's `mutants` field.
