---
"@titan-design/factory": patch
---

Shepherd's attestation lineage walk now treats the broker principal `human` as a lineage root when the roster has no row for it, which is how `agent ls --json --include-retired` reads in production. A reviewer Shepherd spawned can meet an attestation row again instead of every row gating `meeter-is-author`. Any other name absent from the roster still proves nothing, and the test fixtures no longer add a synthetic `human` row.
