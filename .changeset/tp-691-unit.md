---
"@titan-design/evals": minor
---

TP-691a: ship the `review-pr` unit and its `live-brief` variant under `units/review-pr/`, plus three building blocks for the private case builder. `reviewPrBrief` renders the live `reviewerBrief` with only its checkout lines swapped for bundle paths. `materializeBundle` writes `head/`, `base/` (via `git archive`, no `.git`) and `diff.patch` from a local clone through a git-only port. `private/exclusion` ports F6's three-layer private exclusion (allowlist, markers read from an active-work root, final assertion) with a self-test.
