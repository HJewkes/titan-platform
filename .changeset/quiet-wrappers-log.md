---
"@titan-design/tool-guard": minor
---

Add the `titan-merge-lint` bin and a `./merge-lint` export: a text-level lint that warns on a merge call (`gh pr merge`, a REST `pulls/N/merge` or `repos/R/merges` route, GraphQL `mergePullRequest`, `enablePullRequestAutoMerge` or `enqueuePullRequest`, octokit `pulls.merge`) outside the allowlist in `.github/merge-lint.json`.
