---
"@titan-design/github": minor
---

`CheckRun` gains `completedAt` (null until the run completes) and `title` (the run's `output.title`, null when it set none), mapped from `completed_at` and `output.title` by `listCheckRuns` on both the gh and Octokit wires (TP-3522). Both are required fields, so an external implementer of `GitHubWire` or a hand-built `CheckRun` must add them.
