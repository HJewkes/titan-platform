---
"@titan-design/factory": patch
---

Shepherd now sends a `--kind test-only` run on to review when its fix-proof is NO_REPRO on a diff of test support with no test in it, under `noReproProceed`. Such a diff plans no test, so the classifier flagged it and the run went back to its implementer and then to an owner `sh-sent-back` gate. Correctness and security runs on the same diff stay gated, as does any diff that changes source, deletes a test or does not read in full.
