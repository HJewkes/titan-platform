---
"@titan-design/worktree": minor
---

`inspectForRelease` and `sweepWorktrees` accept an `ignoredFiles` policy (`{ disposable: string[] }`) naming extra ignored paths that do not block release or make a tree hold work. Patterns support `*` and `**` and cover everything beneath a match. With no policy the behaviour is unchanged.
