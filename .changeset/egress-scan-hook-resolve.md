---
"@titan-design/egress-scan": patch
---

The pre-push hook now finds the scanner in the pushing worktree, then the main checkout's `node_modules`, then `PATH`, so a linked worktree without `node_modules` can push. It still exits 1 when none is found, and the message names the three places it looked.
