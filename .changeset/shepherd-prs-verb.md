---
"@titan-design/factory": minor
"@titan-design/github": minor
---

`titan-factory shepherd prs [owner/repo] --json` lists every open PR of each seat repo, or of the one named, from Shepherd's PR snapshot, plus the PRs Shepherd merged in the last 24 hours. Each row carries the branch, head, base, state, title, body, draft flag, whether Shepherd has it registered (with its run id and phase), the snapshot's cached CI for the head when it holds one, its source and when it was read. Open rows answer with no GitHub call while the open list is under a minute old, and concurrent callers share one list read. A merged row's `mergeSha` comes from the run's merge step, never from a PR read. A seat repo with no run in it is still listed.

`@titan-design/github`: `PullRequest` gains optional `title` and `body`, which the gh wire now fills from the REST answer (a null body reads as an empty string).
