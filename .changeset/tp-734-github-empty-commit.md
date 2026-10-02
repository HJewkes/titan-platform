---
"@titan-design/github": minor
---

Add `pushEmptyCommit` to `GitHubPort`: it pushes a commit with the head's own tree onto a branch so CI runs again, and skips when the branch moved. The wire gains `createCommit` and `updateRef`, `getCommit` reports the commit's `tree`, and the fake counts `updateRef` effects.
