---
"@titan-design/github": minor
"@titan-design/factory": patch
---

`Commit` gains an optional `committedAt`, the committer date, which the `gh api` wire reads from `git/commits`. The factory's `land` now refreshes a behind PR in a repo without strict required checks when its base moved after the head's last green run: before a green verdict goes on to approve-merge, `ci-wait` compares the base tip's committer date with the earliest start of the head's latest required GitHub Actions runs. A base tip committed later, or one with no readable date or run start, is treated as moved, so the verdict is `behind` and the existing update-branch path runs under the same update cap before CI is awaited at the new head. A strict repo keeps its behaviour.
