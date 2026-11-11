---
"@titan-design/worktree": patch
---

`gitRunnerWithDeadline` now routes through `gitOrNull`, which takes an optional kill signal, so `git.ts` has one `execFile` call site. Timeouts, SIGKILL and null-on-failure are unchanged.
