---
"@titan-design/owner-queue": minor
---

Add `OwnerOp`, the typed target of an owner action: `ownerOpSchema` is a strict union of `resolve-gate`, `release-hold`, `merge-at-head`, `close-pr`, `factory-config-set`, `deploy-pause-clear` and `retire-agent`. An item and a deposit may carry an optional `op`. `fromDeposit` adds the `pr:<repo>#<n>@<head>` key an op implies, so a deposit about a PR merges with that PR's item at the same head; it never derives a `gate:` key. `opKeys(op)` returns those keys.
