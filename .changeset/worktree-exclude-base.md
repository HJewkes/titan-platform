---
"@titan-design/worktree": minor
---

Allocation now appends the worktree base (`/.worktrees/` by default, or the configured `basePath`) to `<git-common-dir>/info/exclude`, so the primary's `git status` no longer lists it as untracked. The append is idempotent, creates the file when absent, keeps existing lines, and writes the primary's file even when allocating from inside a worktree.
