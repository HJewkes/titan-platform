---
"@titan-design/factory": patch
---

Shepherd's test-only diff reads a tsconfig change that only adds or removes `*.test.ts` entries in `include` or `exclude` as test support, so a vacuous NO_REPRO proceeds under `noReproProceed`; any other tsconfig change stays source.
