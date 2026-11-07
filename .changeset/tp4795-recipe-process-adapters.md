---
"@titan-design/factory": patch
---

The redeploy, tree-carry and post-merge recipe files no longer import `node:child_process` or `node:fs`, or read `Date`, `process` or timers. Their process, git, filesystem, clock and environment code moved unchanged into `redeploy-adapter.ts`, `tree-carry-adapter.ts` and `post-merge-adapter.ts`, and the recipes re-export what importers use. No step id, order or recorded input or output changes.
