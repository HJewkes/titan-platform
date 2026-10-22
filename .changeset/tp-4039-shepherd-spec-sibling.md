---
"@titan-design/factory": patch
---

Shepherd's `testOnlyDiff` reads a PR that changes only a mutation spec as test-only when the spec's sibling test exists at the head (TP-4039). It probes each spec's sibling by test extension, since GitHub lists no directory, and passes what it finds to the fix-proof plan, so Shepherd and the CI plan agree. A spec with no readable sibling stays flagged as adding no test.
