---
"@titan-design/factory": patch
---

Add the Shepherd `test-only` kind, gated like correctness and inert: no run may move into it until `TEST_ONLY_GATED` is lifted (TP-2732 d). Add `testOnlyDiff`, a fail-closed classifier of a PR's diff by the base ref's fix-proof globs.
