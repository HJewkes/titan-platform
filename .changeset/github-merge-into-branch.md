---
"@titan-design/github": minor
---

Add `mergeIntoBranch` to `GitHubWire` and `GitHubPort`: GitHub's Merges API merges a commit into a branch without a pull request. A 201 answers `merged` with the merge commit sha, a 204 answers `already-contained`, a 409 answers `conflict`, and any other status throws. The fake records each call in `branchMerges` and answers a conflict for any head in `mergeConflicts`.
