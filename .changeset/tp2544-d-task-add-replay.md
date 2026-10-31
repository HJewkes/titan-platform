---
"@titan-design/active-work": patch
---

Add `scripts/task-add-replay.mjs`, a read-only replay of recent task creation against the done_when gate and title similarity bands, and depend on `@titan-design/memory` for its `jaccard` (TP-2544).
