---
"@titan-design/worktree": patch
---

`runGit` and the setup `gitOutput` now give up on a hung git after `DEFAULT_GIT_TIMEOUT_MS` (60 seconds) and kill it with SIGKILL, so a stalled git returns null instead of hanging the caller. `worktree add` keeps its own explicit timeout.
