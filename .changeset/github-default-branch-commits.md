---
"@titan-design/github": minor
---

Add `listDefaultBranchCommits(repo, since)` to the port: every default-branch commit committed at or after `since`, as `{ sha, message }` (`LoggedCommit`), newest first. The fake answers it from `history`.
