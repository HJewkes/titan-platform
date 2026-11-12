---
"@titan-design/factory": patch
---

Shepherd's attest evidence step waits under the `attest-deploy-skew` guard row, which land re-reads each round with no owner gate, while main holds commits touching `products/factory/src/registry/**` or a `closure.lock.json` that the running build lacks. A failed read also waits. Shepherd's git-cache clone registers the closure-lock merge driver and `attr.tree` before it merges, so it no longer depends on `pnpm prepare` (TP-4752).
