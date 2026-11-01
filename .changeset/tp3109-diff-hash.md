---
"@titan-design/github": minor
"@titan-design/review-panel": minor
---

Add I2's diff pin and Q13's two carry exclusions (TP-3109). `gitDiffPin` fetches `main` fresh, takes `merge-base --all`, and hashes the v9.1 §2.3 diff under `HARDENED_GIT_ENV` into a `full` and a `core` SHA-256; an ambiguous or missing base gives a pin that matches nothing. `serialiseDiff` and `diffHashes` are the pure canonicaliser. `diffCarry` carries a diff-pinned fact on an equal `full` hash, or on an equal `core` with a merge of main that `gitMergeUpCheck` proves with `merge-tree --write-tree`. `gitMergeTree` takes an optional env. `@titan-design/review-panel` classes the diff-hash files as authority, so a canonicaliser change needs an adversary.
