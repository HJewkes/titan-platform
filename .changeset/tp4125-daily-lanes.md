---
"@titan-design/explainer": minor
---

The daily gather places each merged PR in one lane from a `daily/lanes.yaml` rule file (branch seat, then repo, then paths), marks it a goal, side quest or other, threads PRs by task, ranks threads, and writes lane, goal, ship and day rollup facts plus a `coverage.json` saying which PRs a lane names and which it counts. A host `daily/lanes.yaml` replaces the doctrine default.
