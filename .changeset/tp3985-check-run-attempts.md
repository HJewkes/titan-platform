---
"@titan-design/github": minor
---

`GitHubPort.checkRunAttempts(repo, sha)` lists every run on a sha with each rerun's earlier attempts kept, by asking GitHub for `filter=all`; `GitHubWire.listCheckRuns` takes that filter as an optional third argument. `checkRuns` is unchanged and keeps GitHub's default `filter=latest`, which hides a rerun job's earlier attempts in the same workflow run; its doc now says so. The fake models that default: `listCheckRuns` without the filter hides superseded attempts of one workflow run.
