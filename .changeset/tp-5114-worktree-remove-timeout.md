---
"@titan-design/agent-dispatch": patch
---

Releasing a worktree no longer gives `git worktree remove` the 60 s default git deadline. It runs under a named 10-minute `WORKTREE_REMOVE_TIMEOUT_MS`, so removing a large built tree is not killed halfway and reported as a refused release.
