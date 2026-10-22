---
"@titan-design/factory": patch
---

Shepherd's test-only register hint and its fix-proof wake brief no longer steer a flaky-test fix into adding a mutation spec. A spec keeps a vacuous proof NO_REPRO even with `noReproProceed` on, so both now tell a test-only flake fix to register `--kind test-only` and leave out any `*.mutations.json` (TP-3987).
