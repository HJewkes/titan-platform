---
"@titan-design/review-panel": minor
"@titan-design/factory": patch
---

An adversary fix round gets a focus section (TP-6412). Given a usable fix-round scope, `shapeBrief("adversary", …)` adds a
section that points at the change since the last reviewed head, its line ranges, and the open findings, while the brief
still reads the whole PR's diff and carries no unchanged-line rule. Every other member's brief still drops the scope.
Under `shepherd.review.scopedRereview: on`, Shepherd passes the scope to the adversary member only, and records its
`sh-review` result as `scopeFocus: true` rather than `scoped`. Under `shadow` and `off` the adversary brief is unchanged.
