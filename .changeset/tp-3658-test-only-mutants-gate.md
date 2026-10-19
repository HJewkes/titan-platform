---
"@titan-design/fix-proof": minor
"@titan-design/review-panel": patch
"@titan-design/factory": minor
---

A pull request that only adds or changes tests can now prove itself without an owner waiver (TP-3658). `@titan-design/fix-proof` exports `provedByMutants(result)`: true when a `vacuous` result's mutation check is `killed`, every changed test file has a spec of its own in the diff, and every selected test ran and passed at head. The judge lists changed test files without a spec as `mutants.uncovered` and demotes `killed` to `not-killed` when any remain, so a spec beside an unchanged test cannot vouch for a test the PR changed. The fix-proof workflow gains a `fix-proof-mutants` job that runs `exec --side mutants` in the sandbox when the diff adds or changes a `*.mutations.json` spec, and the judge reads its report. Shepherd's fix-proof gate lets such a head go to review; a surviving mutation, a failing or unrun test, or a mutants error still ends the round as `NO_REPRO`, and the wake asks for kills. The tests reviewer's brief reads a proved head as proved rather than as a blocking vacuous proof. A run may now move into `--kind test-only`, under the existing diff check.
