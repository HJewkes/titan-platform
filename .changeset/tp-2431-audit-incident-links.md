---
"@titan-design/factory": patch
---

The owner-gate audit links a deploy incident to merge M when its rollout first brought M in: the target holds M and the build it replaced did not. `buildAudit` takes an `isAncestor` probe; no matching incident reads as zero, and an unreadable ancestry or a missing log reads as unknown.
