---
"@titan-design/worktree": minor
---

Add a `ghTimeoutMs` allocator option (and a matching trailing `inspectForRelease` argument) that bounds each `gh pr view` a release makes. It defaults to the old fixed 3 seconds, exported as `DEFAULT_GH_TIMEOUT_MS`.
