---
"@titan-design/review-panel": patch
"@titan-design/factory": patch
---

Add `shepherd.gateReset.noReproProceed` (off by default): a test-only PR whose diff the classifier reads as tests alone goes to review on a vacuous or test-less fix-proof, recorded as unverified `no-repro-test-only`; the reviewer brief names it.
