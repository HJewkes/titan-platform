---
"@titan-design/github": minor
---

Add `listReviewComments` to the GitHub port: every inline review comment on a PR with its reviewer, path, line, body and resolved state. The `gh` adapter reads it from GraphQL review threads, the only place GitHub reports resolution; `fakeGitHub` serves it from `reviewComments`.
