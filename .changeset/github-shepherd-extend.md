---
"@titan-design/github": minor
---

Add `CheckRun.appId` and `CheckRun.headSha`, `PullRequest.headRepo`, `jobLogTail`, `deleteRef` (refuses the default branch and fork heads), `listOpenPrs`, ETag conditional GETs with a shared rate budget that backs off below 500 remaining, and a pure `mergeReadiness`. Ref names containing `%` are now refused. Every `gh api` call now runs with `-i`, and lists follow `Link` pages instead of `--paginate`.
