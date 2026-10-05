---
"@titan-design/worktree": patch
---

Release and sweep now refuse a worktree whose files git cannot vouch for. They share park's unsaved-work check: `git status --porcelain -uall`, so `status.showUntrackedFiles=no` cannot hide an untracked file; a status git cannot read (a broken gitdir) counts as dirty; and an ignored file outside node_modules, dist, coverage, .turbo and a top-level .claude refuses. Removal no longer retries with `--force` when git's own remove refuses, unless the caller forced; release and `reclaimWorktree` report that refusal instead of claiming success.
