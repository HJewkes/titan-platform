---
"@titan-design/factory": patch
---

Shepherd's post-merge redeploy now queues the green main commit that sh-main-ci read, not the merge sha, when the merge's own main run was cancelled and a newer push answered for it. Before, a burst of merges acknowledged on one green tip queued in the same second, and the oldest merge sha overwrote the tip in the deploy pacer's record: the pacer then deployed that older commit, or cleared it because the running build already held it, and the tip waited for a manual deploy. The step id is unchanged; the input gains an optional `greenSha`.
