---
"@titan-design/github": minor
"@titan-design/factory": minor
---

`shepherd prs` rows now carry what `gh pr checks` prints. `ci` gains `checks` (the newest run per name with its status, conclusion, times, link and title), `statuses` (the head's commit statuses, which the PR snapshot now reads beside its runs on the same cadence), `required` (the run's land-rules contexts) and `settled`. `ci.head` is the sha the cached runs were read for, so a list whose head moved since shows the mismatch. `CommitStatus` gains optional `targetUrl`, `description`, `createdAt` and `updatedAt`, mapped by the gh-cli wire.
