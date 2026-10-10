---
"@titan-design/github": minor
"@titan-design/factory": minor
---

`GitHubPort.defaultBranch(repo)` reads the repo's default branch, and `GitHubPort.merge` takes an optional `expectedBase`: a PR on another base skips as `base-changed`, checked before the write and before each retry. The land core now records a `base-check` before every merge. An approved head whose pull request is based on anything but the default branch waits in `base-wait`, with no timeout, until the pull request is retargeted; a Shepherd run gives its repo's merge train up before it waits. An approval or policy allow covers one base: after a retarget the run re-reads the merge evidence and decides again, the `approve-merge` prompt names the base, and an approval never follows to a head on another base. A green read that names a new base re-reads the branch rules. A seat's `merge-into-feature-base` grant lets its runs merge into a stacked pull request's own base. `shepherd status` names the refused base as the next action.
