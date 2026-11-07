---
"@titan-design/factory": patch
---

TP-4874: `planConsumerBumps` reads each non-denied seat-book consumer at its default branch and plans its `@titan-design/*` bumps, and `registerConsumerBump` registers a bump PR under the consumer seat's own policy with no fixer.
