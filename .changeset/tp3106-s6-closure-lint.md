---
"@titan-design/factory": patch
---

TP-3106 S6: each fact entry's import closure is hashed into `src/registry/closure.lock.json`. CI's new `pnpm registry:closure` step fails when that lock is stale, or when a step's closure changed against `origin/main` with neither a new schema hash, a new `version.bump`, nor an attestation for the new closure in `src/registry/attestations.json`. The build adds `dist/registry/closure-main.js`, which the check runs.
