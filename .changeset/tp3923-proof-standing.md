---
"@titan-design/fix-proof": minor
"@titan-design/review-panel": patch
"@titan-design/review-workflow": minor
"@titan-design/factory": patch
---

`proofStanding(read, head)` in fix-proof is the one reading of a fix-proof read at a head: `proved`, `no-repro` (with `proceeds` for a test-only or non-source NO_REPRO the caller lets through), `unverified`, `unproven` or `none`. `endsReview` and `needsTestsSeat` answer the two questions callers ask of it, and `FixProofUnverified` moves here. Shepherd's gate and waiver and review-panel's `fixProofNeedsTests` now derive from it instead of parsing the line each in their own way; no behavior changes, and `unproven` still lets the review run while making the tests seat blocking. review-panel re-exports `FixProofUnverified` unchanged. review-workflow's `ProofRead` is now fix-proof's `ProofReadInput` (TP-3923).
