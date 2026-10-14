---
"@titan-design/github": patch
---

The fake GitHub's merge now moves the PR's base branch to the merge sha, as GitHub does. Before, the base branch stayed on its pre-merge sha, and the fake's default compare read that stale tip as a newer push containing the merge.
