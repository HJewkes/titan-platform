---
"@titan-design/github": minor
"@titan-design/factory": minor
---

`GitHubPort.defaultBranch(repo)` reads the repo's default branch. The land core now records a `base-check` before every merge. An approved head whose pull request is based on anything but the default branch waits in `base-wait`, with no timeout, until the pull request is retargeted. A green read that names a new base re-reads the branch rules, and the merge step skips a base retargeted after its check as `base-changed`. Shepherd's `--policy '{"featureBase":true}'` lets a stacked pull request merge into its own base. `shepherd status` names the refused base as the next action.
