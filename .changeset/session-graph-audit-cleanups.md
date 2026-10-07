---
"@titan-design/session-graph": patch
---

Drop the unused `@titan-design/cluster` dependency. `applyAssets` now binds named parameters through the same binder as the audit apply path, so a boolean field in an asset row is coerced instead of throwing.
