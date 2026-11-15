---
"@titan-design/evals": patch
---

Make `bench judge review-fa` work on a real review run: read the scorer's `cited` field, judge a false alarm with no citation as a whole review, rebuild case bundles from `--cases` and `--repo-root`, and add `bench judge review-fa-controls` to generate the controls.
