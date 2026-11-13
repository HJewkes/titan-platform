---
"@titan-design/factory": patch
"@titan-design/github": minor
---

GitHubPort gains `refActivity`, a branch's repository activity with the account that made each push. Shepherd keeps and carries the owner's release approve-merge answer only to a head that the configured `shepherd.releaseAppLogin` (a `[bot]` login) pushed. It also counts an added CHANGELOG.md as a release file only when the package.json beside it is modified (TP-5606).
