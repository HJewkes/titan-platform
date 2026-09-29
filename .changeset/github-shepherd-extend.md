---
"@titan-design/github": minor
---

Add `CheckRun.appId`, `PullRequest.headRepo`, `jobLogTail`, `deleteRef` (refuses the default branch and fork heads), `listOpenPrs`, ETag conditional GETs with a shared rate budget that backs off below 500 remaining, and a pure `mergeReadiness`. Every `gh api` call now runs with `-i`, and lists follow `Link` pages instead of `--paginate`.
