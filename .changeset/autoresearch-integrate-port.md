---
"@titan-design/factory": minor
---

The autoresearch evaluator gains the `integrate` port: it merges a later round winner onto the round's new head in the run's integration tree, in a detached checkout and never pushing. The merge commit is dated with the step's first start, so a restarted step rebuilds the same sha. A conflict is aborted, which leaves the tree clean, and the conflicting files are named. The ratchet port passes the move's `kind` through unchanged.
