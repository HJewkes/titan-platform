---
"@titan-design/factory": minor
---

`titan-factory planner probe <merges|owner-contact|new-red> --since <iso>` prints one line per event in the window, for a planner wake's `priorWindow` commands to point at. `merges` reads PRs merged per seat repo (or each `--repo`), `owner-contact` reads gate resolves and answered console rounds, and `new-red` reads failed main runs and `ci-failed` gates opened in the window. A source it cannot read exits non-zero, so the wake runs the review.
