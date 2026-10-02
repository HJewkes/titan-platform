---
"@titan-design/worktree": patch
---

`copyClaudeDir` now lstats `<worktree>/.claude` before copying. A branch that commits `.claude` as a symlink (dangling or not), a file, or a directory no longer has the repository's `.claude` copied through it; the allocation and re-attach results report a warning instead.
