---
"@titan-design/factory": patch
---

With `shepherd.gateReset.noReproProceed` on, a `correctness` PR whose diff the classifier reads as tests, mutation specs and changesets alone now goes to review on a vacuous fix-proof as `no-repro-test-only`, as a `test-only` one does, rather than gating on an owner waiver. Security runs, diffs that touch source, and lines carrying mutants keep their NO_REPRO.
