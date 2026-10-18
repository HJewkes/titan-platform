---
"@titan-design/code-graph": patch
---

Honour a caller-set GIT_DIR when discovery with it stripped finds no repo. A work tree with no `.git`, whose git dir lives elsewhere (`core.worktree` set), can now be indexed at a revision: `gitTreeSource`, `resolveCommit`, `listTreeBlobs`, `readBlobs`, the churn and first-seen logs and `revisionLineSource` all use the caller's env for that `repoRoot`. Discovery with the stripped env still wins, so a hook's GIT_DIR never redirects a call, and a `.git`-less work tree nested inside another repo still resolves the outer repo.
