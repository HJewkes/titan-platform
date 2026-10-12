---
"@titan-design/github": minor
"@titan-design/factory": patch
---

Bind the sh-fix-proof run to the registered PR and base branch, so a run for another PR at the same head cannot supply the result (TP-2357 b). `CheckRun.pullRequests` is a new required field, so an external implementer of `GitHubWire` or a hand-built `CheckRun` must add it (an empty array when the run names no PR).
